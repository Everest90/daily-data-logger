import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

async function digestCode(code: string, pepper: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(code));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const pepper = Deno.env.get("WORKSPACE_CODE_PEPPER");
  if (!supabaseUrl || !anonKey || !serviceRoleKey || !pepper) {
    return json({ error: "Workspace access is not configured on the server." }, 500);
  }

  const accessToken = request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!accessToken) return json({ error: "A signed-in device session is required." }, 401);

  const userClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error: userError } = await userClient.auth.getUser(accessToken);
  if (userError || !user) return json({ error: "Device session is invalid. Reconnect and try again." }, 401);

  let body: {
    action?: string;
    workspaceName?: string;
    code?: string;
    deviceName?: string;
    timezone?: string;
  };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Request body must be valid JSON." }, 400);
  }

  const code = body.code?.trim();
  if (!code || code.length < 12 || code.length > 128) {
    return json({ error: "Workspace code must be between 12 and 128 characters." }, 400);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { count, error: countError } = await admin.from("workspace_access_attempts")
    .select("device_id", { count: "exact", head: true })
    .eq("device_id", user.id)
    .gte("attempted_at", since);
  if (countError) return json({ error: "Could not verify workspace access limits." }, 500);
  if ((count ?? 0) >= 10) return json({ error: "Too many attempts. Try again in 15 minutes." }, 429);

  const { error: attemptError } = await admin.from("workspace_access_attempts").insert({ device_id: user.id });
  if (attemptError) return json({ error: "Could not record workspace access attempt." }, 500);

  const codeDigest = await digestCode(code, pepper);
  const deviceName = (body.deviceName?.trim() || "Team device").slice(0, 120);

  if (body.action === "create") {
    const name = body.workspaceName?.trim();
    if (!name || name.length > 120) {
      return json({ error: "Workspace name must be between 1 and 120 characters." }, 400);
    }

    const { data: workspace, error: workspaceError } = await admin.from("workspaces")
      .insert({ name, timezone: body.timezone || "UTC" })
      .select("id, name, timezone")
      .single();
    if (workspaceError || !workspace) return json({ error: "Could not create the workspace." }, 500);

    const { error: credentialError } = await admin.from("workspace_credentials")
      .insert({ workspace_id: workspace.id, code_digest: codeDigest });
    if (credentialError) {
      await admin.from("workspaces").delete().eq("id", workspace.id);
      if (credentialError.code === "23505") {
        return json({ error: "That workspace code is already in use. Choose another." }, 409);
      }
      return json({ error: "Could not save the workspace credential." }, 500);
    }

    const { error: deviceError } = await admin.from("workspace_devices").upsert({
      workspace_id: workspace.id,
      device_id: user.id,
      device_name: deviceName,
      last_seen_at: new Date().toISOString(),
      revoked_at: null,
    });
    if (deviceError) {
      await admin.from("workspaces").delete().eq("id", workspace.id);
      return json({ error: "Could not authorize this device." }, 500);
    }
    return json({ workspace });
  }

  if (body.action === "join") {
    const { data: credential, error: credentialError } = await admin.from("workspace_credentials")
      .select("workspace_id")
      .eq("code_digest", codeDigest)
      .maybeSingle();
    if (credentialError) return json({ error: "Could not verify the workspace code." }, 500);
    if (!credential) return json({ error: "Workspace code was not recognized." }, 404);

    const { error: deviceError } = await admin.from("workspace_devices").upsert({
      workspace_id: credential.workspace_id,
      device_id: user.id,
      device_name: deviceName,
      last_seen_at: new Date().toISOString(),
      revoked_at: null,
    });
    if (deviceError) return json({ error: "Could not authorize this device." }, 500);

    const { data: workspace, error: workspaceError } = await admin.from("workspaces")
      .select("id, name, timezone")
      .eq("id", credential.workspace_id)
      .single();
    if (workspaceError || !workspace) return json({ error: "Could not load the workspace." }, 500);
    return json({ workspace });
  }

  return json({ error: "Action must be either create or join." }, 400);
});
