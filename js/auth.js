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

// ---------- Profiles ----------
const PROFILE_FIELDS = 'id, display_name, username, bio, avatar_url, favorite_anime, favorite_genres, created_at';

async function currentUserId() {
  const { data } = await client.auth.getSession();
  const id = data.session?.user?.id;
  if (!id) throw new Error('Please sign in first.');
  return id;
}

function profileError(error) {
  const code = error?.code;
  const msg = error?.message || '';
  if (code === '23505' || /profiles_username_key|duplicate key/i.test(msg)) return 'That username is already taken. Try another one.';
  if (code === '23514' || /violates check constraint/i.test(msg)) {
    if (/username/i.test(msg)) return 'Usernames are 3–20 characters: lowercase letters, numbers and underscores.';
    if (/bio/i.test(msg)) return 'Your bio can be up to 280 characters.';
    if (/display_name/i.test(msg)) return 'Display name can be up to 40 characters.';
    if (/favorite_genres/i.test(msg)) return 'Pick up to 10 favorite genres.';
    return 'One of the fields isn’t valid. Please check and try again.';
  }
  return friendly(error);
}

export async function getProfile() {
  const id = await currentUserId();
  const { data, error } = await client.from('profiles').select(PROFILE_FIELDS).eq('id', id).maybeSingle();
  if (error) throw new Error(profileError(error));
  if (data) return data;
  // Safety net: the sign-up trigger normally creates this row.
  const { data: created, error: insErr } = await client.from('profiles').insert({ id }).select(PROFILE_FIELDS).single();
  if (insErr) throw new Error(profileError(insErr));
  return created;
}

export async function updateProfile(fields) {
  const id = await currentUserId();
  const { data, error } = await client.from('profiles').update(fields).eq('id', id).select(PROFILE_FIELDS).single();
  if (error) throw new Error(profileError(error));
  return data;
}

// Stores the (already resized) image at avatars/{user_id}/avatar.{ext} and returns its public URL.
export async function uploadAvatar(blob) {
  const id = await currentUserId();
  const ext = blob.type === 'image/webp' ? 'webp' : blob.type === 'image/png' ? 'png' : 'jpg';
  const bucket = client.storage.from('avatars');
  // Remove any previous avatar with a different extension.
  const { data: existing } = await bucket.list(id);
  const stale = (existing || []).map(f => `${id}/${f.name}`).filter(p => p !== `${id}/avatar.${ext}`);
  if (stale.length) await bucket.remove(stale);
  const path = `${id}/avatar.${ext}`;
  const { error } = await bucket.upload(path, blob, { upsert: true, contentType: blob.type, cacheControl: '3600' });
  if (error) throw new Error(friendly(error));
  return `${bucket.getPublicUrl(path).data.publicUrl}?v=${Date.now()}`;
}

export async function removeAvatar() {
  const id = await currentUserId();
  const bucket = client.storage.from('avatars');
  const { data: existing } = await bucket.list(id);
  const paths = (existing || []).map(f => `${id}/${f.name}`);
  if (paths.length) {
    const { error } = await bucket.remove(paths);
    if (error) throw new Error(friendly(error));
  }
}
