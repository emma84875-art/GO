// Connects the queue to the templates. The queue passes a template id and its stored data; this
// renders them with the app's base URL and an authentication link builder.
//
// authLink receives a nonce, never a stored token. The caller is expected to issue a single-use
// token for the nonce at send time and return the full HTTPS link.

import { renderTemplate, type RenderContext, type TemplateId } from './templates.ts';
import type { RenderedEmail } from './render.ts';

export function makeRenderer(ctx: RenderContext): (job: { readonly template: TemplateId; readonly data: Record<string, unknown> }) => RenderedEmail {
  return (job) => renderTemplate(job.template, job.data as never, ctx);
}
