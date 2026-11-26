/** wa.me needs the country code: a bare 10-digit Indian mobile gets 91 in front. */
export const waNumber = (phone: string) => { const d = phone.replace(/\D/g, '').replace(/^0(?=\d{10}$)/, ''); return d.length === 10 ? `91${d}` : d; };
