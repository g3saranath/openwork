import { useCallback, useEffect, useRef, useState } from "react";

import { desktopFetch } from "@/app/lib/desktop";
import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import { isMeaningfulTranscript, readDictationEvent } from "./dictation-events";

export type DictationStatus = "idle" | "starting" | "listening" | "error";

type UseDictationOptions = {
  client: OpenworkServerClient | null;
  /** Called once per completed utterance with the corrected transcript. */
  onFinalTranscript: (text: string) => void;
};

export type DictationController = {
  status: DictationStatus;
  error: string | null;
  /** Live, uncorrected text for the utterance currently being spoken. */
  interim: string;
  supported: boolean;
  start: () => Promise<void>;
  stop: () => void;
  toggle: () => void;
};

function waitForDataChannelOpen(channel: RTCDataChannel) {
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timeout);
      channel.removeEventListener("open", handleOpen);
      channel.removeEventListener("close", handleClose);
      channel.removeEventListener("error", handleError);
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("Dictation channel did not open in time."));
    }, 10_000);
    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleClose = () => {
      cleanup();
      reject(new Error("Dictation channel closed before opening."));
    };
    const handleError = () => {
      cleanup();
      reject(new Error("Dictation channel failed."));
    };
    channel.addEventListener("open", handleOpen);
    channel.addEventListener("close", handleClose);
    channel.addEventListener("error", handleError);
  });
}

/**
 * macOS gates microphone access at the OS level on top of the Chromium prompt.
 * Non-Electron and non-darwin runtimes fall through as already granted.
 */
async function requestMacMicrophoneAccess() {
  const ask = window.__OPENWORK_ELECTRON__?.system?.askMicrophoneAccess;
  if (!ask) return true;
  const result = await ask();
  if (result.platform !== "darwin") return true;
  return result.granted;
}

/**
 * Composer dictation over the same OpenWork Realtime broker Voice Mode uses,
 * but minted in `transcription` mode so the model only listens. Partial deltas
 * stream into `interim`; each completed utterance is handed to
 * `onFinalTranscript` and the interim buffer resets.
 */
export function useDictation(options: UseDictationOptions): DictationController {
  const [status, setStatus] = useState<DictationStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [interim, setInterim] = useState("");

  const peerRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const interimRef = useRef("");
  const startingRef = useRef(false);

  const onFinalRef = useRef(options.onFinalTranscript);
  useEffect(() => {
    onFinalRef.current = options.onFinalTranscript;
  }, [options.onFinalTranscript]);

  const supported =
    typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia) && typeof RTCPeerConnection !== "undefined";

  const teardown = useCallback(() => {
    channelRef.current?.close();
    channelRef.current = null;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    peerRef.current?.close();
    peerRef.current = null;
    interimRef.current = "";
    setInterim("");
  }, []);

  const commitInterim = useCallback(() => {
    const pending = interimRef.current.trim();
    interimRef.current = "";
    setInterim("");
    if (pending && isMeaningfulTranscript(pending)) onFinalRef.current(pending);
  }, []);

  const handleMessage = useCallback((raw: string) => {
    const event = readDictationEvent(interimRef.current, raw);
    if (event.type === "interim") {
      interimRef.current = event.interim;
      setInterim(event.interim);
      return;
    }
    if (event.type === "final") {
      interimRef.current = "";
      setInterim("");
      onFinalRef.current(event.transcript);
      return;
    }
    if (event.type === "reset") {
      interimRef.current = "";
      setInterim("");
      return;
    }
    if (event.type === "error") {
      setError(event.message);
      setStatus("error");
    }
  }, []);

  const stop = useCallback(() => {
    if (!peerRef.current && !streamRef.current) {
      setStatus("idle");
      return;
    }
    // Commit whatever was mid-utterance so stopping never silently drops words.
    commitInterim();
    teardown();
    setStatus("idle");
  }, [commitInterim, teardown]);

  const start = useCallback(async () => {
    if (startingRef.current || peerRef.current) return;
    const client = options.client;
    if (!client) {
      setError("OpenWork is still connecting. Try again in a moment.");
      setStatus("error");
      return;
    }
    if (!supported) {
      setError("Microphone capture is unavailable in this runtime.");
      setStatus("error");
      return;
    }

    startingRef.current = true;
    setError(null);
    setStatus("starting");
    try {
      const granted = await requestMacMicrophoneAccess();
      if (!granted) {
        throw new Error(
          "macOS denied microphone access. Enable OpenWork in System Settings > Privacy & Security > Microphone, then restart OpenWork.",
        );
      }

      const session = await client.createVoiceRealtimeSession({ mode: "transcription" });

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;

      const peer = new RTCPeerConnection();
      peerRef.current = peer;
      for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);

      const channel = peer.createDataChannel("oai-events");
      channelRef.current = channel;
      channel.addEventListener("message", (event) => handleMessage(String(event.data)));

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (!offer.sdp) throw new Error("Dictation offer did not include SDP.");

      const sdpResponse = await desktopFetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.clientSecret}`, "Content-Type": "application/sdp" },
        body: offer.sdp,
      });
      if (!sdpResponse.ok) {
        const detail = await sdpResponse.text().catch(() => "");
        throw new Error(`Dictation could not connect: ${sdpResponse.status} ${detail}`.trim());
      }
      await peer.setRemoteDescription({ type: "answer", sdp: await sdpResponse.text() });
      await waitForDataChannelOpen(channel);

      // Defensive: an older broker may hand back a conversational session. This
      // guarantees the model stays silent even then, so dictation never talks back.
      channel.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            output_modalities: ["text"],
            audio: {
              input: {
                transcription: { model: session.transcriptionModel, language: "en" },
                turn_detection: {
                  type: "server_vad",
                  threshold: 0.5,
                  silence_duration_ms: 600,
                  prefix_padding_ms: 300,
                  create_response: false,
                  interrupt_response: false,
                },
              },
            },
          },
        }),
      );

      setStatus("listening");
    } catch (caught) {
      teardown();
      setError(caught instanceof Error ? caught.message : String(caught));
      setStatus("error");
    } finally {
      startingRef.current = false;
    }
  }, [handleMessage, options.client, supported, teardown]);

  const toggle = useCallback(() => {
    if (status === "listening" || status === "starting") stop();
    else void start();
  }, [start, status, stop]);

  useEffect(() => teardown, [teardown]);

  return { status, error, interim, supported, start, stop, toggle };
}
