// Signal channel configuration
export const SIGNAL_PHONE_NUMBER =
  process.env.SIGNAL_PHONE_NUMBER || envConfig.SIGNAL_PHONE_NUMBER || '';

export const SIGNAL_SOCKET_PATH =
  process.env.SIGNAL_SOCKET_PATH ||
  envConfig.SIGNAL_SOCKET_PATH ||
  '/run/signal-cli/socket';

// --- Patch messageHasTrigger() ---
// Signal users may @mention the assistant by phone number instead of name
// (e.g., "@+15102143647" rather than "@Jorgenclaw"). Add phone-number matching
// inside messageHasTrigger() after the existing TRIGGER_PATTERN check:
//
//   if (SIGNAL_PHONE_NUMBER && /^@\+?\d/.test(trimmed)) {
//     const digits = SIGNAL_PHONE_NUMBER.replace(/^\+/, '');
//     if (trimmed.startsWith(`@+${digits}`) || trimmed.startsWith(`@${digits}`)) {
//       return true;
//     }
//   }
