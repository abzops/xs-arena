// The how-to-use tour's steps, English and Malayalam. Targets are data-guide attributes in the Shell.
export type Lang = 'en' | 'ml';
export type Step = { target?: string; title: Record<Lang, string>; body: Record<Lang, string>; perm?: string };

export const GUIDE_STEPS: Step[] = [
  { title: { en: 'Welcome to XS Arena', ml: 'XS Arena-യിലേക്ക് സ്വാഗതം' },
    body: { en: 'Your whole day runs from six places: Home, Floor, XS AI, Bookings, Bills and Customers. Everything else is folded away until you need it. This takes one minute.',
      ml: 'ദിവസത്തെ ജോലി മുഴുവൻ ആറ് ഇടങ്ങളിൽ നിന്നാണ്: Home, Floor, XS AI, Bookings, Bills, Customers. ബാക്കിയെല്ലാം ആവശ്യം വരുമ്പോൾ മാത്രം തുറന്നാൽ മതി. ഒരു മിനിറ്റ് കൊണ്ട് കാണിച്ചു തരാം.' } },
  { target: 'nav-home', title: { en: 'Home', ml: 'Home' },
    body: { en: "Today's collection, open bills, dues and what's busy right now — at a glance.", ml: 'ഇന്നത്തെ കളക്ഷൻ, തുറന്ന ബില്ലുകൾ, ബാക്കി പൈസ, ഇപ്പോൾ ഏതൊക്കെ ടേബിൾ ബിസി — എല്ലാം ഒറ്റനോട്ടത്തിൽ.' } },
  { target: 'nav-floor', perm: 'floor.operate', title: { en: 'Floor', ml: 'Floor' },
    body: { en: 'Your hall as a map. Tap a free table to start a game (name and mobile first), tap a busy one to add time, pause, or end and bill.',
      ml: 'ഹാളിന്റെ മാപ്പ്. ഫ്രീ ടേബിളിൽ ടാപ്പ് ചെയ്ത് പേരും മൊബൈലും കൊടുത്ത് ഗെയിം തുടങ്ങാം. ബിസി ടേബിളിൽ ടാപ്പ് ചെയ്താൽ സമയം കൂട്ടാം, പോസ് ചെയ്യാം, അവസാനിപ്പിച്ച് ബിൽ ചെയ്യാം.' } },
  { target: 'nav-ai', perm: 'floor.operate', title: { en: 'XS AI', ml: 'XS AI' },
    body: { en: 'Just say it: "Snooker 1 start 1 hour", "PS5 2 add 30 minutes", "today\'s collection". Works in Malayalam too.',
      ml: 'പറഞ്ഞാൽ മതി: "സ്നൂക്കർ 1 സ്റ്റാർട്ട് 1 മണിക്കൂർ", "PS5 2 അര മണിക്കൂർ കൂട്ട്", "ഇന്നത്തെ കളക്ഷൻ". മലയാളത്തിലും പറയാം.' } },
  { target: 'nav-bookings', perm: 'floor.operate', title: { en: 'Bookings', ml: 'Bookings' },
    body: { en: "Online and phone bookings. When the customer arrives, tap Check in and scan the QR on their phone — then pick the table.",
      ml: 'ഓൺലൈനിലും ഫോണിലും വന്ന ബുക്കിംഗുകൾ. കസ്റ്റമർ വന്നാൽ Check in അമർത്തി അവരുടെ ഫോണിലെ QR സ്കാൻ ചെയ്യുക — പിന്നെ ടേബിൾ തിരഞ്ഞെടുക്കുക.' } },
  { target: 'nav-bills', perm: 'billing.create', title: { en: 'Bills', ml: 'Bills' },
    body: { en: 'Every open and paid bill. Take cash, UPI or card, and send the receipt as an image on WhatsApp.',
      ml: 'എല്ലാ ബില്ലുകളും. ക്യാഷ്, UPI, കാർഡ് — ഏതായാലും എടുക്കാം. റെസീപ്റ്റ് WhatsApp-ൽ ഇമേജായി അയക്കാം.' } },
  { target: 'nav-customers', title: { en: 'Customers', ml: 'Customers' },
    body: { en: 'Everyone who played, with visits, spend and points. Used for offers and loyalty.', ml: 'കളിച്ച എല്ലാവരും — എത്ര തവണ വന്നു, എത്ര ചിലവാക്കി, പോയിന്റുകൾ. ഓഫറുകൾ അയക്കാൻ ഇത് ഉപയോഗിക്കാം.' } },
  { target: 'group-more', title: { en: 'More tools', ml: 'More tools' },
    body: { en: 'Open this when you need it: Shift & cash, Repairs (report anything broken), Assets (cues, controllers, games on each PS5), offers, expenses and the day summary.',
      ml: 'ആവശ്യമുള്ളപ്പോൾ തുറക്കുക: Shift & cash, Repairs (കേടായത് റിപ്പോർട്ട് ചെയ്യാൻ), Assets (ക്യൂ, കൺട്രോളർ, ഓരോ PS5-ലെയും ഗെയിമുകൾ), ഓഫറുകൾ, ചിലവുകൾ, ഡേ സമ്മറി.' } },
  { target: 'group-setup', perm: 'pricing.manage', title: { en: 'Setup', ml: 'Setup' },
    body: { en: 'For the owner, once: prices, the floor designer, staff logins (Team) and settings.', ml: 'ഓണർക്ക്, ഒരിക്കൽ ചെയ്താൽ മതി: വിലകൾ, ഫ്ലോർ ഡിസൈനർ, സ്റ്റാഫ് ലോഗിൻ (Team), സെറ്റിംഗ്സ്.' } },
  { target: 'guide', title: { en: "That's it", ml: 'ഇത്രയേ ഉള്ളൂ' },
    body: { en: 'Open this guide again any time from "How to use".', ml: '"How to use" അമർത്തിയാൽ ഈ ഗൈഡ് എപ്പോൾ വേണമെങ്കിലും വീണ്ടും കാണാം.' } },
];

