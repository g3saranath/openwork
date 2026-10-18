import { useCallback } from "react";

import { useLocal } from "../../../kernel/local-provider";

export function useFeatureFlagsPreferences() {
  const { prefs, setPrefs } = useLocal();

  const workspaceRunModeEnabled = prefs.featureFlags?.workspaceRunMode === true;
  const toggleWorkspaceRunMode = useCallback(() => {
    setPrefs((previous) => ({
      ...previous,
      featureFlags: {
        ...previous.featureFlags,
        workspaceRunMode: !previous.featureFlags?.workspaceRunMode,
      },
    }));
  }, [setPrefs]);

  const sessionTransferEnabled = prefs.featureFlags?.sessionTransfer === true;
  const toggleSessionTransfer = useCallback(() => {
    setPrefs((previous) => ({
      ...previous,
      featureFlags: {
        ...previous.featureFlags,
        sessionTransfer: !previous.featureFlags?.sessionTransfer,
      },
    }));
  }, [setPrefs]);

  return {
    workspaceRunModeEnabled,
    toggleWorkspaceRunMode,
    sessionTransferEnabled,
    toggleSessionTransfer,
  };
}
