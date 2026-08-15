# Named Codex Accounts With Legacy Home Compatibility

CCDM will identify Codex accounts with stable aliases that map to Codex homes, while retaining raw `codex_home` selectors for backward compatibility. A named selector and a raw-home selector at the same configuration scope are mutually exclusive, unknown aliases and unusable selected homes fail before lifecycle mutation, and one shared resolver keeps root and project precedence consistent; this adds indirection and validation but avoids moving credentials or silently launching under the wrong account.
