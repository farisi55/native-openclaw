/**
 * scheduler/scheduler-intent.ts
 * Lightweight Indonesian/English scheduler intent parser.
 */

import { getOptionalEnv } from '../config/env';
import { dailyCronExpression } from './scheduler-store';
import type { SchedulerIntent, SchedulerListFilter, ScheduleType } from './scheduler-types';

const DEFAULT_TIMEZONE = 'Asia/Jakarta';
const TIME_RE = /(?:jam|pukul|at)\s*(\d{1,2})(?:[.:](\d{2}))?/i;

export interface ParseSchedulerIntentOptions {
  now?: Date;
  timezone?: string;
}

function schedulerTimezone(override?: string): string {
  return override ?? getOptionalEnv('SCHEDULER_TIMEZONE', DEFAULT_TIMEZONE) ?? DEFAULT_TIMEZONE;
}

function normalizeTime(hourRaw: string, minuteRaw?: string): string | null {
  const hour = Number(hourRaw);
  const minute = minuteRaw === undefined ? 0 : Number(minuteRaw);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'cronjob';
}

function stripScheduleWords(input: string): string {
  return input
    .replace(/buatkan\s+cronjob(?:\s+nya)?/gi, '')
    .replace(/itu\s+(?:akan\s+)?jadi\s+cronjob(?:\s+kamu)?(?:\s+yang\s+baru)?/gi, '')
    .replace(/\bcronjob\s+baru\b/gi, '')
    .replace(/\bcronjob\b/gi, '')
    .replace(/\bjob\s+baru\b/gi, '')
    .replace(/\bjadwalkan\b/gi, '')
    .replace(/\bschedule\b/gi, '')
    .replace(/\bsetiap\s+hari\b/gi, '')
    .replace(/\bsetiap\s+jam\s+\d{1,2}(?:[.:]\d{2})?\b/gi, '')
    .replace(/\b\d+\s*(?:menit|minute|minutes|jam|hour|hours|detik|second|seconds)\s+(?:lagi|kemudian|dari\s+sekarang|from\s+now|later|after)\b/gi, '')
    .replace(/\b(?:setelah|after|dalam|in)\s+\d+\s*(?:menit|minute|minutes|jam|hour|hours|detik|second|seconds)\b/gi, '')
    .replace(/\b(?:dari\s+sekarang|from\s+now|nanti|later)\b/gi, '')
    .replace(/\bhari\s+ini\s+jam\s+\d{1,2}(?:[.:]\d{2})?\b/gi, '')
    .replace(/\bjam\s+\d{1,2}(?:[.:]\d{2})?\b/gi, '')
    .replace(/[,.;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameFromInput(input: string, scheduleType: ScheduleType): string {
  const lower = input.toLowerCase();
  if (lower.includes('berita') && lower.includes('arsenal')) {
    return lower.includes('email') ? 'berita-arsenal-email' : 'berita-arsenal';
  }
  if (lower.includes('harga emas') || lower.includes('gold price')) {
    return `report-harga-emas-${scheduleType === 'daily' ? 'daily' : scheduleType}`;
  }

  const reminderFor = /(?:meeting|rapat)(?:\s+dengan\s+([a-z0-9 _-]+))?/i.exec(input);
  if (lower.includes('reminder') || lower.includes('ingatkan')) {
    const suffix = reminderFor?.[1] ? `meeting-${reminderFor[1]}` : stripScheduleWords(input);
    return slugify(`reminder ${suffix}`);
  }

  return slugify(stripScheduleWords(input));
}

function promptFromInput(input: string): string {
  const lower = input.toLowerCase();
  const asksEmail = /\b(?:email|e-mail|mail)\b/i.test(input);

  if (/\b(?:balas|reply|jawab)\b/i.test(input) && !asksEmail) {
    const trailingReply = /\b(?:dengan|with)\s+["']?([^"']{1,80})["']?\s*$/i.exec(input);
    const directReply = /\b(?:balas|reply|jawab)\s+(?:pesan\s+ini\s+)?(?:dengan\s+)?["']?(.+?)(?:\s+(?:\d+\s*(?:menit|jam|detik|seconds?|minutes?|hours?)\s*(?:lagi|kemudian|dari\s+sekarang)|setelah\s+\d+|dalam\s+\d+|nanti|besok|tomorrow|in\s+\d+|jam\s+\d{1,2}|pukul\s+\d{1,2})\b|$)/i.exec(input);
    const replyText = (trailingReply?.[1] ?? directReply?.[1] ?? '').trim().replace(/[.。]+$/, '');
    if (replyText) {
      return `Balas dengan pesan: "${replyText}". Tulis hanya pesan balasan tersebut, tanpa komentar tambahan.`;
    }
    return 'Balas dengan pesan yang sesuai konteks percakapan. Tulis hanya pesan balasan, singkat dan langsung.';
  }

  if (lower.includes('berita') && lower.includes('arsenal')) {
    if (asksEmail) {
      return 'Cari berita terbaru Arsenal dari sumber online terpercaya menggunakan web-fetch. Ringkas dalam bahasa Indonesia. Kirimkan ringkasan tersebut ke email default user menggunakan tool brevo-email. Gunakan BREVO_RECIPIENT_EMAIL jika user tidak menyebutkan alamat email eksplisit. Jangan gunakan placeholder email. Jangan klaim email terkirim kecuali brevo-email mengonfirmasi sukses.';
    }
    return 'Cari berita terbaru Arsenal dari sumber online terpercaya menggunakan web-fetch. Ringkas hasilnya dalam bahasa Indonesia.';
  }

  const reminder = /(?:untuk\s+)?mengingatkan\s+saya\s+(?:bahwa\s+)?(.+)$/i.exec(input);
  if (reminder?.[1]) {
    return `Kirim email reminder bahwa ${reminder[1].trim().replace(/[.。]+$/, '')}.`;
  }

  if (lower.includes('harga emas') || lower.includes('gold price')) {
    if (asksEmail) {
      return 'Cari harga emas terbaru menggunakan web-fetch dari sumber terpercaya (antam.com atau logammulia.com). Ringkas data harga beli, harga jual, dan trend hari ini dalam bahasa Indonesia. Kirimkan ringkasan tersebut ke email default user menggunakan tool brevo-email. Gunakan BREVO_RECIPIENT_EMAIL jika user tidak menyebutkan alamat email eksplisit. Jangan klaim email terkirim kecuali brevo-email mengonfirmasi sukses.';
    }
    return 'Cari harga emas terbaru menggunakan web-fetch dari sumber terpercaya (antam.com atau logammulia.com). Tampilkan harga beli, harga jual, dan trend hari ini dalam bahasa Indonesia.';
  }

  if (lower.includes('berita ai')) {
    return 'Kirim rangkuman berita AI terbaru.';
  }

  const cleaned = stripScheduleWords(input);
  return cleaned ? cleaned[0]!.toUpperCase() + cleaned.slice(1) : input.trim();
}

function timeZoneParts(date: Date, timezone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0');
  return { year: value('year'), month: value('month'), day: value('day') };
}

function timeZoneOffsetMs(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const value = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour'),
    value('minute'),
    value('second')
  );
  return asUtc - date.getTime();
}

function runAtDayOffset(time: string, dayOffset: number, now: Date, timezone: string): string {
  const [hourText, minuteText] = time.split(':');
  const parts = timeZoneParts(now, timezone);
  const guess = new Date(Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day + dayOffset,
    Number(hourText),
    Number(minuteText),
    0,
    0
  ));
  return new Date(guess.getTime() - timeZoneOffsetMs(guess, timezone)).toISOString();
}

function runAtToday(time: string, now: Date, timezone: string): string {
  return runAtDayOffset(time, 0, now, timezone);
}

function parseTime(input: string): string | null {
  const match = TIME_RE.exec(input);
  return match?.[1] ? normalizeTime(match[1], match[2]) : null;
}

function intervalMetadata(input: string): { intervalMs: number; description: string } | null {
  const match = /setiap\s+(\d+)\s*(menit|minute|minutes|jam|hour|hours)/i.exec(input);
  if (!match?.[1] || !match[2]) return null;
  const amount = Number(match[1]);
  if (!Number.isInteger(amount) || amount <= 0) return null;
  const unit = match[2].toLowerCase();
  const intervalMs = unit.startsWith('menit') || unit.startsWith('minute')
    ? amount * 60_000
    : amount * 60 * 60_000;
  return { intervalMs, description: `setiap ${amount} ${unit}` };
}

function relativeDelay(input: string): { delayMs: number; description: string } | null {
  const p1 = /\b(\d+)\s*(menit|jam|detik|second|seconds|minute|minutes|hour|hours)\s+(?:lagi|kemudian|dari\s+sekarang|from\s+now|after|later)\b/i.exec(input);
  const p2 = /\b(?:setelah|after|dalam|in)\s+(\d+)\s*(menit|jam|detik|second|seconds|minute|minutes|hour|hours)\b/i.exec(input);
  const p3 = /\bin\s+(\d+)\s*(minutes?|hours?|seconds?)\b/i.exec(input);
  const match = p1 ?? p2 ?? p3;
  if (!match?.[1] || !match[2]) return null;

  const amount = Number(match[1]);
  if (!Number.isInteger(amount) || amount <= 0) return null;
  const unit = match[2].toLowerCase();
  if (unit.startsWith('detik') || unit.startsWith('second')) {
    return { delayMs: amount * 1_000, description: `${amount} detik dari sekarang` };
  }
  if (unit.startsWith('menit') || unit.startsWith('minute')) {
    return { delayMs: amount * 60_000, description: `${amount} menit dari sekarang` };
  }
  return { delayMs: amount * 60 * 60_000, description: `${amount} jam dari sekarang` };
}

function taskSummaryFromInput(input: string): string | undefined {
  const lower = input.toLowerCase();
  if (lower.includes('berita') && lower.includes('arsenal') && /\b(?:email|e-mail|mail)\b/i.test(input)) {
    return 'cari berita terbaru Arsenal dan kirim ke email default Anda';
  }
  if ((lower.includes('harga emas') || lower.includes('gold price')) && /\b(?:email|e-mail|mail)\b/i.test(input)) {
    return 'kirim report harga emas ke email default Anda';
  }
  if (lower.includes('reminder')) {
    return 'kirim reminder sesuai permintaan';
  }
  return undefined;
}

export function looksLikeSchedulerRequest(input: string): boolean {
  if (/\b(cronjob|cron|jadwal|jadwalkan|schedule|scheduler|reminder|alarm)\b/i.test(input)) return true;
  if (/\b(setiap\s+jam|setiap\s+hari|setiap\s+\d+\s*(?:menit|jam)|every\s+\d+\s*(?:minutes?|hours?)|menit\s+lagi|jam\s+lagi|hapus\s+cronjob|lihat\s+(?:semua\s+)?cronjob|list\s+cronjob|disable\s+cronjob|enable\s+cronjob)\b/i.test(input)) return true;

  const actionVerbRe = /\b(?:kirim|send|balas|reply|email|ingatkan|remind|notify|kabari|call)\b/i;
  const timePattern = /\b(\d+)\s*(menit|jam|detik|second|seconds|minute|minutes|hour|hours)\s*(?:lagi|kemudian|dari\s+sekarang|from\s+now|after|later)\b/i.exec(input);
  if (timePattern) {
    const unit = timePattern[2]?.toLowerCase() ?? '';
    const isSeconds = unit.startsWith('detik') || unit.startsWith('second');
    if (!isSeconds) return true;
    if (actionVerbRe.test(input)) return true;
  }
  const prefixTimePattern = /\b(?:setelah|after|dalam)\s+\d+\s*(menit|jam|detik|second|seconds|minute|minutes|hour|hours)\b/i.exec(input);
  if (prefixTimePattern) {
    const unit = prefixTimePattern[1]?.toLowerCase() ?? '';
    const isSeconds = unit.startsWith('detik') || unit.startsWith('second');
    if (!isSeconds) return true;
    if (actionVerbRe.test(input)) return true;
  }
  if (/\bin\s+\d+\s*(?:minutes?|hours?|seconds?)\b/i.test(input) && actionVerbRe.test(input)) return true;
  if (/\b(?:nanti|besok|tomorrow)\b/i.test(input) && /\b(?:kirim|balas|reply|send|ingatkan|remind)\b/i.test(input)) return true;
  if (/\b(?:hari\s+ini|today)\b/i.test(input) && /\b(?:ingatkan|remind)\b/i.test(input)) return true;
  if (/\bbangunkan\b/i.test(input) && /\b(?:jam|pukul|at|\d{1,2}[:h]|\d{4})\b/i.test(input)) return true;
  if (/\b(?:wake\s+me|alarm)\s+(?:saya|me)?\s*(?:jam|pukul|at)?\s*\d{1,2}/i.test(input)) return true;
  if (/\b(?:kabari|follow\s+up|followup)\s+(?:saya|me)?\s*(?:nanti|besok|tomorrow|in\s+\d+)/i.test(input)) return true;
  if (/\bfollow\s*up\b[\s\S]{0,60}\b(?:besok|tomorrow|nanti|in\s+\d+)/i.test(input)) return true;
  if (/\bbalas\s+(?:email|pesan|message)\s+(?:ini\s+)?(?:nanti|besok|tomorrow|in\s+\d+|\d+\s*(?:menit|jam))/i.test(input)) return true;
  if (/\bdi(?:kirim|kirimkan|ingatkan)\b/i.test(input) && /\b(?:\d+\s*(?:menit|jam|detik)|nanti|besok)\b/i.test(input)) return true;
  if (/\b(?:kirimkan\s+saya|ingatkan\s+saya|remind\s+me|send\s+me)\b/i.test(input)) return true;
  if (/\b(?:di)?kirimkan?\b/i.test(input) && /\b(?:nanti|lagi|dari\s+sekarang|in\s+\d+|menit|jam|detik)\b/i.test(input)) return true;
  if (/\bsend\s+me\b/i.test(input) && /\b(?:in\s+\d+|later|nanti)\b/i.test(input)) return true;
  return false;
}

function listFilter(input: string): SchedulerListFilter {
  if (/\b(nonaktif|disabled|mati)\b/i.test(input)) return 'disabled';
  if (/\b(aktif|active|enabled|sedang\s+aktif|yang\s+aktif)\b/i.test(input)) return 'active';
  return 'all';
}

function isListIntent(input: string): boolean {
  return (
    /\b(?:lihat|list|daftar|tampilkan|show)\b[\s\S]*\b(?:cronjob|cron|jobs?|jadwal|schedule)s?\b/i.test(input) ||
    /\b(?:ada\s+)?(?:cronjob|cron|jobs?|jadwal|schedule)s?\s+apa\s+saja\b/i.test(input) ||
    /\b(?:cronjob|cron|jobs?)\s+(?:yang\s+)?(?:sedang\s+)?aktif\b/i.test(input) ||
    /\b(?:cronjob|cron|jobs?)\s+(?:yang\s+)?(?:nonaktif|disabled|mati)\b/i.test(input) ||
    /\b(?:active|enabled|disabled|scheduled|current)\s+(?:cronjobs?|jobs?)\b/i.test(input) ||
    /\bshow\s+active\s+jobs?\b/i.test(input)
  );
}

function isCreateIntent(input: string): boolean {
  return (
    /\b(?:lihat|list|daftar|tampilkan|show|apa\s+saja)\b/i.test(input) ? false :
    /\b(?:buat|buatkan|tambahkan|create|add)\s+(?:cronjob|cron|job|schedule|reminder|alarm)\b/i.test(input) ||
    /\b(?:buat\s+job\s+baru|cronjob\s+baru|new\s+cronjob|new\s+job)\b/i.test(input) ||
    /\bitu\s+(?:akan\s+)?jadi\s+cronjob\b/i.test(input) ||
    /\b(?:make\s+this\s+a\s+cronjob|schedule\s+this)\b/i.test(input) ||
    /\b(?:jadwalkan|schedule-kan)\b/i.test(input) ||
    /\bschedule\s+(?!s?$)(?:a\s+)?(?:cronjob|job|reminder)\b/i.test(input) ||
    /\b(?:buat|create|set)\s+(?:reminder|alarm)\b/i.test(input) ||
    /\b(?:ingatkan\s+saya|remind\s+me)\b/i.test(input) ||
    /\bbangunkan\s+(?:saya|me)\b/i.test(input) ||
    /\bset\s+alarm\b/i.test(input) ||
    /\b(?:kabari|follow\s+up|followup)\s+(?:saya|me)?\s*(?:nanti|besok|in\s+\d+)/i.test(input) ||
    /\b(?:kirim|kirimkan|send)\s+(?:setiap|every)\b/i.test(input) ||
    /\b(?:kirim|kirimkan|send|ingatkan|remind|update|laporan|report)\b[\s\S]{0,50}\b(?:setiap|every)\b/i.test(input) ||
    /\b(?:kirim|kirimkan|send)\s+(?:email\s+)?reminder\b/i.test(input) ||
    /\b(?:kirimkan\s+saya|send\s+me)\b[\s\S]{0,80}\b(?:nanti|\d+\s*(?:menit|jam|detik)\s*(?:lagi|kemudian|dari\s+sekarang)|in\s+\d+\s*(?:minutes?|hours?|seconds?))\b/i.test(input) ||
    /\b(?:kirim|send)\s+(?:email|laporan|report|pesan)\b[\s\S]{0,60}\b(?:nanti|in\s+\d+|\d+\s*(?:menit|jam)\s*(?:lagi|dari\s+sekarang))\b/i.test(input) ||
    /\bsaya\s+ingin\s+di(?:kirim|kirimkan)\b/i.test(input) ||
    /\bdi(?:kirim|kirimkan)\b[\s\S]{0,80}\b\d+\s*(?:menit|jam|detik)\s*(?:lagi|kemudian|dari\s+sekarang)\b/i.test(input) ||
    /\bnanti\b[\s\S]{0,40}\b(?:kirim|send|balas|reply)\b/i.test(input) ||
    /\b(?:balas|reply)\b[\s\S]{0,40}\bnanti\b/i.test(input) ||
    /\b\d+\s*(?:menit|jam|detik|second|seconds|minute|minutes|hour|hours)\s*(?:lagi|kemudian|dari\s+sekarang|from\s+now|after|later)\b/i.test(input) ||
    /\b(?:setelah|after|dalam)\s+\d+\s*(?:menit|jam|detik|second|seconds|minute|minutes|hour|hours)\b/i.test(input) ||
    /\bin\s+\d+\s*(?:minutes?|hours?|seconds?)\b/i.test(input) ||
    /\bsend\s+(?:email|me)\s+in\s+\d+\s*(?:minutes?|hours?|seconds?)\b/i.test(input) ||
    /\bsend\s+email\s+(?:at|in)\b/i.test(input) ||
    /\bsetiap\s+hari\s+jam\s+\d{1,2}(?:[.:]\d{2})?\b/i.test(input) ||
    /\bhari\s+ini\s+jam\s+\d{1,2}(?:[.:]\d{2})?\b[\s\S]*\b(?:mengingatkan|reminder|meeting|rapat)\b/i.test(input) ||
    /\b(?:besok|tomorrow)\b[\s\S]{0,50}\b(?:jam|pukul|at)\s*\d{1,2}(?:[.:]\d{2})?\b/i.test(input) ||
    /\bfollow\s*up\b[\s\S]{0,60}\b(?:besok|tomorrow|nanti|in\s+\d+)/i.test(input)
  );
}

export function parseSchedulerIntent(
  input: string,
  options: ParseSchedulerIntentOptions = {}
): SchedulerIntent {
  const trimmed = input.trim();
  const timezone = schedulerTimezone(options.timezone);
  const now = options.now ?? new Date();

  if (!looksLikeSchedulerRequest(trimmed)) {
    return { intent: 'unknown', requiresClarification: false };
  }

  if (isListIntent(trimmed)) {
    return {
      intent: 'list',
      filter: listFilter(trimmed),
      timezone,
      requiresClarification: false,
    };
  }

  const getMatch = /^(?:get|detail|lihat|show)\s+(?:cronjob|cron|job|schedule)\s+(.+)$/i.exec(trimmed);
  if (getMatch?.[1]) {
    return { intent: 'get', targetJob: getMatch[1].trim(), timezone, requiresClarification: false };
  }

  const deleteMatch = /^(?:hapus|delete|remove)\s+(?:cronjob|cron|job|schedule)\s+(.+)$/i.exec(trimmed);
  if (deleteMatch?.[1]) {
    return { intent: 'delete', targetJob: deleteMatch[1].trim(), timezone, requiresClarification: false };
  }

  const disableMatch = /^(?:disable|nonaktifkan|matikan)\s+(?:cronjob|cron|job|schedule)\s+(.+)$/i.exec(trimmed);
  if (disableMatch?.[1]) {
    return { intent: 'disable', targetJob: disableMatch[1].trim(), timezone, requiresClarification: false };
  }

  const enableMatch = /^(?:enable|aktifkan|nyalakan)\s+(?:cronjob|cron|job|schedule)\s+(.+)$/i.exec(trimmed);
  if (enableMatch?.[1]) {
    return { intent: 'enable', targetJob: enableMatch[1].trim(), timezone, requiresClarification: false };
  }

  const updateMatch = /^update\s+(?:cronjob|cron|job|schedule)\s+(.+?)\s+(?:menjadi|ke|to)\s+(?:jam|pukul|at)\s*(\d{1,2})(?:[.:](\d{2}))?$/i.exec(trimmed);
  if (updateMatch?.[1] && updateMatch[2]) {
    const time = normalizeTime(updateMatch[2], updateMatch[3]);
    if (!time) {
      return {
        intent: 'update',
        targetJob: updateMatch[1].trim(),
        timezone,
        requiresClarification: true,
        clarificationQuestion: 'Jam cronjob tidak valid. Gunakan format HH:mm.',
      };
    }
    return {
      intent: 'update',
      targetJob: updateMatch[1].trim(),
      timezone,
      time,
      cronExpression: dailyCronExpression(time),
      requiresClarification: false,
    };
  }

  const runMatch = /^(?:run|jalankan)\s+(?:cronjob|cron|job|schedule)\s+(.+?)(?:\s+sekarang)?$/i.exec(trimmed);
  if (runMatch?.[1]) {
    return { intent: 'run_now', targetJob: runMatch[1].trim(), timezone, requiresClarification: false };
  }

  if (!isCreateIntent(trimmed)) {
    return { intent: 'unknown', timezone, requiresClarification: false };
  }

  const relative = relativeDelay(trimmed);
  if (relative) {
    return {
      intent: 'create',
      name: nameFromInput(trimmed, 'once'),
      description: relative.description,
      scheduleType: 'once',
      runAt: new Date(now.getTime() + relative.delayMs).toISOString(),
      timezone,
      prompt: promptFromInput(trimmed),
      metadata: {
        relativeDescription: relative.description,
        taskSummary: taskSummaryFromInput(trimmed) ?? promptFromInput(trimmed),
      },
      requiresClarification: false,
    };
  }

  const interval = intervalMetadata(trimmed);
  if (interval) {
    return {
      intent: 'create',
      name: nameFromInput(trimmed, 'interval'),
      description: interval.description,
      scheduleType: 'interval',
      timezone,
      prompt: promptFromInput(trimmed),
      metadata: { intervalMs: interval.intervalMs },
      requiresClarification: false,
    };
  }

  const time = parseTime(trimmed);
  const daily = /\b(setiap\s+jam|setiap\s+hari|daily|every\s+day)\b/i.test(trimmed);
  const onceToday = /\b(hari\s+ini|today)\b/i.test(trimmed);
  const tomorrow = /\b(besok|tomorrow)\b/i.test(trimmed);

  if (daily && time) {
    return {
      intent: 'create',
      name: nameFromInput(trimmed, 'daily'),
      scheduleType: 'daily',
      cronExpression: dailyCronExpression(time),
      timezone,
      time,
      prompt: promptFromInput(trimmed),
      requiresClarification: false,
    };
  }

  if ((onceToday || tomorrow) && time) {
    const runAt = tomorrow ? runAtDayOffset(time, 1, now, timezone) : runAtToday(time, now, timezone);
    if (!tomorrow && new Date(runAt).getTime() <= now.getTime()) {
      return {
        intent: 'create',
        scheduleType: 'once',
        timezone,
        time,
        runAt,
        requiresClarification: true,
        clarificationQuestion: `Waktu ${time} sudah lewat hari ini. Mau dijadwalkan untuk besok atau pilih jam lain?`,
      };
    }
    return {
      intent: 'create',
      name: nameFromInput(trimmed, 'once'),
      scheduleType: 'once',
      runAt,
      timezone,
      time,
      prompt: promptFromInput(trimmed),
      requiresClarification: false,
    };
  }

  if (isCreateIntent(trimmed)) {
    return {
      intent: 'create',
      timezone,
      requiresClarification: true,
      clarificationQuestion: 'Kapan cronjob ini harus dijalankan? Contoh: hari ini jam 15:00 atau setiap hari jam 08:00.',
    };
  }

  return { intent: 'unknown', timezone, requiresClarification: false };
}
