/** A button in an alert email. Built only on the server, from validated inquiry fields. */
export type EmailAction = { label: string; href: string };

/** Hrefs the email template will render; anything else is dropped. */
export function isSafeActionHref(href: string) {
  return /^(?:https:\/\/|http:\/\/localhost[:/]|tel:\+\d+$)/.test(href);
}

/**
 * The customer's number in international form without "+" (as `wa.me` expects), or
 * null when it is not a recognisable Nigerian number. Accepts local `0XXXXXXXXXX` and
 * `+234`/`234` forms with spaces, dashes, dots, or brackets.
 */
export function nigerianWhatsAppNumber(phone: string) {
  const digits = phone.replace(/[\s().-]/g, "").replace(/^\+/, "");
  if (!/^\d+$/.test(digits)) return null;
  if (/^0[789][01]\d{8}$/.test(digits)) return `234${digits.slice(1)}`;
  if (/^234[789][01]\d{8}$/.test(digits)) return digits;
  return null;
}

type AlertInquiry = {
  id: string;
  reference: string;
  phone: string;
  preferredContactMethod?: "phone" | "whatsapp" | "either";
};

/**
 * One-tap actions for the internal alert, so whoever is on duty can respond from their
 * phone within the 15-minute promise: open the record, reply on WhatsApp (prefilled with
 * the request reference only), or call. A customer who asked for a phone call gets
 * Call first and no WhatsApp button.
 */
export function buildAlertActions(inquiry: AlertInquiry, adminOrigin: string): EmailAction[] {
  const number = nigerianWhatsAppNumber(inquiry.phone);
  const record: EmailAction = { label: "Open in dashboard", href: new URL(`/admin/inquiries/${encodeURIComponent(inquiry.id)}`, adminOrigin).toString() };
  const call: EmailAction | null = number ? { label: "Call", href: `tel:+${number}` } : null;
  const whatsapp: EmailAction | null =
    number && inquiry.preferredContactMethod !== "phone"
      ? { label: "Reply on WhatsApp", href: `https://wa.me/${number}?text=${encodeURIComponent(`Hello, this is M&G Cleaning Services about your request ${inquiry.reference}.`)}` }
      : null;
  const ordered = inquiry.preferredContactMethod === "phone" ? [call, record] : [whatsapp, call, record];
  return ordered.filter((action): action is EmailAction => action !== null && isSafeActionHref(action.href));
}

/** The same actions as plain-text lines, for mail clients that do not show HTML. */
export function actionsAsText(actions: EmailAction[]) {
  return actions.map((action) => `${action.label}: ${action.href}`).join("\n");
}

/** The plain-text part: the message followed by the actions (the HTML part shows them as buttons). */
export function plainTextBody(message: string, actions: EmailAction[]) {
  return [message, actionsAsText(actions)].filter(Boolean).join("\n\n");
}
