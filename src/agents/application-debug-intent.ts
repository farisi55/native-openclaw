const EXPLICIT_SYSTEM_COMMAND_RE =
  /\b(?:jalankan\s+command|jalankan\s+perintah|execute|run\s+command|restart(?:\s+container|\s+service|\s+process)?|kill\s+process|hapus\s+file|delete\s+file|cek\s+proses|check\s+process|docker\s+logs|docker\s+restart|docker\s+stop|systemctl|pm2)\b/i;

const DEBUG_DOMAIN_RE =
  /\b(?:log|logs|logging|warning|warnings?|error|errors?|notif|notifikasi|telegram\s+polling|polling\s+error|polling\s+recovered|recovered\s+log|config|konfigurasi)\b/i;

const DEBUG_ACTION_RE =
  /\b(?:hilangkan|hapus|jangan\s+tampilkan|jangan\s+munculkan|sembunyikan|matikan|suppress|hide|disable|stop|silence|fix|perbaiki|repair|kenapa|why|mengganggu)\b/i;

const TELEGRAM_POLLING_RE =
  /\b(?:telegram\s+polling\s+(?:error|recovered|warning)|getupdates|409|only\s+one\s+bot\s+instance|terminated\s+by\s+other\s+getupdates)\b/i;

export function isExplicitSystemCommandRequest(input: string): boolean {
  return EXPLICIT_SYSTEM_COMMAND_RE.test(input);
}

export function isApplicationDebugRequest(input: string): boolean {
  if (isExplicitSystemCommandRequest(input)) return false;
  if (TELEGRAM_POLLING_RE.test(input) && DEBUG_ACTION_RE.test(input)) return true;
  if (DEBUG_DOMAIN_RE.test(input) && DEBUG_ACTION_RE.test(input)) return true;
  return false;
}

export function isApplicationDebugFixRequest(input: string): boolean {
  if (!isApplicationDebugRequest(input)) return false;
  return /\b(?:hilangkan|hapus|jangan\s+tampilkan|jangan\s+munculkan|sembunyikan|matikan|suppress|hide|disable|stop|silence|fix|perbaiki|repair)\b/i.test(input);
}

export function telegramPollingLogFixInstruction(): string {
  return [
    'Fix Native OpenClaw Telegram polling error/recovery log spam.',
    'Ensure TELEGRAM_LOG_POLLING_ERRORS=false suppresses repeated polling errors.',
    'Ensure TELEGRAM_RECOVERY_LOG_ENABLED=false suppresses polling recovered logs.',
    'Ensure TELEGRAM_SUPPRESS_CONFLICT_ERRORS=true suppresses repeated Telegram 409 getUpdates conflict warnings.',
    'Inspect src/integrations/telegram.ts and keep normal non-conflict error handling intact.',
  ].join(' ');
}

export function applicationDebugDiagnostic(selfHealingEnabled: boolean): string {
  const lines = [
    'Ini bukan permintaan menjalankan OS command. Ini terlihat seperti issue logging/config Native OpenClaw.',
    '',
    'Area yang perlu dianalisis:',
    '- src/integrations/telegram.ts',
    '- TELEGRAM_LOG_POLLING_ERRORS=false',
    '- TELEGRAM_RECOVERY_LOG_ENABLED=false',
    '- TELEGRAM_SUPPRESS_CONFLICT_ERRORS=true',
    '- suppression untuk conflict 409 getUpdates dan log "Telegram polling recovered"',
    '',
    'Kemungkinan akar masalah: integrasi Telegram masih mencetak polling error/recovered walaupun flag suppression sudah diatur.',
  ];

  if (selfHealingEnabled) {
    lines.push('', `Self-healing bisa dijalankan dengan: /heal run ${telegramPollingLogFixInstruction()}`);
  } else {
    lines.push('', `Set SELF_HEALING_ENABLED=true lalu jalankan: /heal run ${telegramPollingLogFixInstruction()}`);
  }

  return lines.join('\n');
}
