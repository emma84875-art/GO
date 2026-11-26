// Public configuration for the GO web app. Only the project URL and the PUBLISHABLE key belong here.
// Never put the service role key, a secret key or a database password in this file or in this app.
//
// Fill these in from the Supabase dashboard (Project Settings, API). Until then the app shows a notice
// and the sign-in and sign-up forms do nothing.
//
// FLIGHT_SEARCH_ENDPOINT: the absolute https address of the search service's search route, for example
// https://<search-service>.onrender.com/api/flights/search. The build adds only this origin to the
// Content-Security-Policy connect-src (scripts/build-web.mjs). Supplier keys (Duffel) live only on that
// server, never here. While this is null the app makes no flight request and shows a 'not connected'
// state. It never shows invented fares. Set it only after the search service is running and its origin
// is listed in that service's SEARCH_ALLOWED_ORIGINS.
// FLIGHT_SEARCH_MODE: the label the results carry, 'sandbox' or 'production' (the server confirms it).
// SUPPORT_EMAIL and SUPPORT_PHONE: published support details. Null until the owner supplies them.
// They are never invented; the page says the details are not yet published while they are null.
export default {
  SUPABASE_URL: 'https://gghsvzighgqqamibjywu.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_n0jNAMww8t8H52CVVAHaGg_Bn0xMuCZ',
  FLIGHT_SEARCH_ENDPOINT: null,
  FLIGHT_SEARCH_MODE: 'sandbox',
  SUPPORT_EMAIL: null,
  SUPPORT_PHONE: null,
};
