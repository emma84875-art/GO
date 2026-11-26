// Shared rendering: escaping, validation, brand tokens, money and time formatting, and the
// responsive layout that every template uses.
//
// Brand (docs/09): Brand Purple #512584 and Brand Orange #FF5738 with ink #1A0B2E on orange.
// Body text is ink or purple on white only. Orange carries a button label in ink, because white
// on orange fails contrast (3.15:1). Emails are always light, with explicit colours, so they do
// not depend on the device's dark mode.

import { formatMoney as formatCoreMoney, historicalMoney, isKnownCurrencyCode } from '../../core/src/money.ts';

export const BRAND = Object.freeze({
  purple: '#512584',
  orange: '#FF5738',
  ink: '#1A0B2E',
  white: '#FFFFFF',
  page: '#F4F1F8',
  muted: '#4A3B5C',
});

export interface RenderedEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export class RenderError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'RenderError';
  }
}

const SUBJECT_MAX = 120;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Plain text that will be placed in an email. Control characters and line breaks are removed,
// because they can split headers or hide content.
export function safeText(value: string, max = 500): string {
  const cleaned = value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) throw new RenderError('empty_text');
  if (cleaned.length > max) throw new RenderError('text_too_long');
  return cleaned;
}

// Only HTTPS links are allowed in email, so a link can never point to plain HTTP or a script URL.
export function safeHttpsUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RenderError('invalid_url');
  }
  if (parsed.protocol !== 'https:') throw new RenderError('url_not_https');
  if (parsed.username || parsed.password) throw new RenderError('url_has_credentials');
  return parsed.toString();
}

export function safeSubject(value: string): string {
  return safeText(value, SUBJECT_MAX);
}

// Money in minor units (for example kobo). The decimal places come from the currency's ISO exponent
// (core), so JPY has none and KWD has three. Integer arithmetic and string formatting only: no floats.
export function formatMoney(amountMinor: number, currency: string): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new RenderError('invalid_amount');
  if (!isKnownCurrencyCode(currency)) throw new RenderError('invalid_currency');
  return formatCoreMoney(historicalMoney(amountMinor, currency));
}

// Local time for a segment, formatted in its own time zone. Throws on an unknown zone.
export function formatLocal(utcIso: string, timeZone: string): string {
  const date = new Date(utcIso);
  if (Number.isNaN(date.getTime())) throw new RenderError('invalid_time');
  const text = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
  return `${text} (${timeZone})`;
}

export interface Cta {
  readonly label: string;
  readonly url: string;
}

export interface LayoutInput {
  readonly title: string;
  readonly preheader: string;
  readonly paragraphs: readonly string[]; // plain text; escaped here
  readonly details?: readonly { readonly label: string; readonly value: string }[];
  readonly cta?: Cta;
  readonly footerNote: string;
}

const FOOTER_DEFAULT = 'This is an account message from GO. Security and booking messages are required and cannot be turned off.';

export function renderLayout(input: LayoutInput): { html: string; text: string } {
  const title = escapeHtml(safeText(input.title, 120));
  const preheader = escapeHtml(safeText(input.preheader, 160));
  const paragraphs = input.paragraphs.map((p) => safeText(p, 1200));
  const details = (input.details ?? []).map((d) => ({ label: safeText(d.label, 60), value: safeText(d.value, 300) }));
  const cta = input.cta ? { label: safeText(input.cta.label, 40), url: safeHttpsUrl(input.cta.url) } : null;
  const footer = escapeHtml(safeText(input.footerNote || FOOTER_DEFAULT, 300));

  const paragraphHtml = paragraphs
    .map((p) => `<p style="margin:0 0 16px;font-size:16px;line-height:24px;color:${BRAND.ink};">${escapeHtml(p)}</p>`)
    .join('\n');
  const detailHtml = details.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border-collapse:collapse;">${details
        .map(
          (d) =>
            `<tr><td style="padding:8px 0;border-top:1px solid #E7E1F0;font-size:14px;color:${BRAND.muted};width:40%;">${escapeHtml(d.label)}</td><td style="padding:8px 0;border-top:1px solid #E7E1F0;font-size:14px;color:${BRAND.ink};">${escapeHtml(d.value)}</td></tr>`,
        )
        .join('')}</table>`
    : '';
  const ctaHtml = cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;"><tr><td style="background:${BRAND.orange};border-radius:8px;"><a href="${escapeHtml(cta.url)}" style="display:inline-block;padding:14px 22px;font-size:16px;font-weight:700;color:${BRAND.ink};text-decoration:none;">${escapeHtml(cta.label)}</a></td></tr></table>`
    : '';

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${title}</title>
<style>
@media only screen and (max-width:600px){.card{width:100%!important;border-radius:0!important}.gutter{padding-left:16px!important;padding-right:16px!important}}
</style>
</head>
<body style="margin:0;padding:0;background:${BRAND.page};font-family:Inter,'Segoe UI',Roboto,Arial,sans-serif;color:${BRAND.ink};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.page};">
<tr><td align="center" class="gutter" style="padding:16px;">
<table role="presentation" class="card" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${BRAND.white};border-radius:12px;overflow:hidden;">
<tr><td style="background:${BRAND.purple};padding:20px 24px;"><span style="font-size:26px;font-weight:700;letter-spacing:1px;color:${BRAND.white};">GO</span></td></tr>
<tr><td class="gutter" style="padding:24px;">
<h1 style="margin:0 0 16px;font-size:22px;line-height:28px;color:${BRAND.purple};">${title}</h1>
${paragraphHtml}
${detailHtml}
${ctaHtml}
</td></tr>
<tr><td class="gutter" style="padding:16px 24px;border-top:1px solid #E7E1F0;font-size:12px;line-height:18px;color:${BRAND.muted};">${footer}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const textLines: string[] = [title, '', ...paragraphs];
  if (details.length) {
    textLines.push('');
    for (const d of details) textLines.push(`${d.label}: ${d.value}`);
  }
  if (cta) {
    textLines.push('', `${cta.label}: ${cta.url}`);
  }
  textLines.push('', footer);
  return { html, text: textLines.join('\n') };
}

export function subjectAndBody(subject: string, layout: { html: string; text: string }): RenderedEmail {
  return { subject: safeSubject(subject), text: layout.text, html: layout.html };
}
