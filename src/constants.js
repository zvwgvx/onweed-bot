// Shared constants.

export const COLORS = {
  warn: 0xfee75c,
  mute: 0xe67e22,
  unmute: 0x57f287,
  kick: 0xf97316,
  ban: 0xed4245,
  unban: 0x57f287,
  note: 0x5865f2,
  info: 0x5865f2,
  success: 0x57f287,
  error: 0xed4245,
  audit: 0x9b59b6,
  gray: 0x95a5a6,
};

// Display metadata per case type.
export const TYPE_META = {
  warn: { label: 'WARN', color: COLORS.warn },
  mute: { label: 'MUTE', color: COLORS.mute },
  unmute: { label: 'UNMUTE', color: COLORS.unmute },
  kick: { label: 'KICK', color: COLORS.kick },
  ban: { label: 'BAN', color: COLORS.ban },
  unban: { label: 'UNBAN', color: COLORS.unban },
  note: { label: 'NOTE', color: COLORS.note },
  addrole: { label: 'ADD ROLE', color: COLORS.success },
  removerole: { label: 'REMOVE ROLE', color: COLORS.gray },
};

export const CASE_STATUS = {
  active: { label: 'Active' },
  expired: { label: 'Expired' },
  removed: { label: 'Removed' },
};

export const MAX_MUTE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
export const MAX_BAN_MS = 365 * 24 * 60 * 60 * 1000; // 365 days

export const HISTORY_PAGE_SIZE = 5;
export const WARNINGS_PAGE_SIZE = 5;
