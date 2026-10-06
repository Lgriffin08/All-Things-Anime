// Email + password accounts and watchlist sync, backed by Supabase.
// The publishable key is meant to be public: row-level security on the
// watchlist table limits every user to their own rows.

const SUPABASE_URL = 'https://eumruuwnbeagszhpemcz.supabase.co';
const SUPABASE_KEY = 'sb_publishable_agvMrFnb4Ch15tUEfTVQTg_Z7qonEwv';
const SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js';

let client = null;

function loadSdk() {
  if (window.supabase?.createClient) return Promise.resolve(window.supabase);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SDK_URL;
    s.async = true;
    s.onload = () => (window.supabase?.createClient ? resolve(window.supabase) : reject(new Error('Supabase SDK missing')));
    s.onerror = () => reject(new Error('Could not load the sign-in service'));
    document.head.appendChild(s);
  });
}

// Starts Supabase and reports auth events: (event, session) => void.
export async function initAuth(onChange) {
  const sdk = await loadSdk();
  client = sdk.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  // Supabase warns against awaiting other Supabase calls inside this callback, so defer.
  client.auth.onAuthStateChange((event, session) => setTimeout(() => onChange(event, session), 0));
}

const redirectTo = () => `${location.origin}/`;

function friendly(error) {
  const msg = error?.message || String(error || 'Something went wrong');
  if (/invalid login credentials/i.test(msg)) return 'That email and password don’t match. Try again or reset your password.';
  if (/email not confirmed/i.test(msg)) return 'Please confirm your email first. Check your inbox for the link we sent.';
  if (/already registered|already exists/i.test(msg)) return 'An account with this email already exists. Try signing in instead.';
  if (/rate limit|too many/i.test(msg)) return 'Too many emails were sent recently. Please wait a bit and try again.';
  if (/password should be at least|weak password/i.test(msg)) return 'Please choose a stronger password (at least 6 characters).';
  if (/unable to validate email|invalid email/i.test(msg)) return 'That doesn’t look like a valid email address.';
  if (/failed to fetch|network/i.test(msg)) return 'Can’t reach the sign-in service. Check your connection and try again.';
  return msg;
}

async function call(fn) {
  if (!client) throw new Error('Sign-in is still loading. Try again in a moment.');
  const { data, error } = await fn();
  if (error) throw new Error(friendly(error));
  return data;
}

export const signIn = (email, password) =>
  call(() => client.auth.signInWithPassword({ email, password }));

// Returns { needsConfirmation } so the UI can tell the user to check their inbox.
export async function signUp(email, password, firstName) {
  const data = await call(() => client.auth.signUp({
    email, password,
    options: { emailRedirectTo: redirectTo(), data: firstName ? { first_name: firstName } : {} },
  }));
  // Supabase returns a user with no identities when the email is already registered.
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    throw new Error(friendly('already registered'));
  }
  return { needsConfirmation: !data.session };
}

export const sendPasswordReset = email =>
  call(() => client.auth.resetPasswordForEmail(email, { redirectTo: redirectTo() }));

export const updatePassword = password =>
  call(() => client.auth.updateUser({ password }));

export const signOut = () => call(() => client.auth.signOut());

// ---------- Watchlist sync ----------
export async function fetchWatchlist() {
  const rows = await call(() => client.from('watchlist')
    .select('anime_id, title, image, titles')
    .order('created_at', { ascending: true }));
  return rows.map(r => ({ id: r.anime_id, title: r.title, image: r.image, titles: r.titles || [] }));
}

export function saveWatchItems(items) {
  if (!items.length) return Promise.resolve();
  const rows = items.map(a => ({ anime_id: a.id, title: a.title, image: a.image || null, titles: a.titles || [] }));
  return call(() => client.from('watchlist').upsert(rows, { onConflict: 'user_id,anime_id' }));
}

export const removeWatchItem = id =>
  call(() => client.from('watchlist').delete().eq('anime_id', id));
