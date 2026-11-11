import type { SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

export const supabaseConfigured = Boolean(url && anonKey);

let client: SupabaseClient | null = null;

export async function getSupabase(): Promise<SupabaseClient | null> {
  if (!url || !anonKey) return null;
  if (client) return client;
  const { createClient } = await import("@supabase/supabase-js");
  client = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
  return client;
}
