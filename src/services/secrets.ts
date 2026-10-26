const SECRET_PREFIX = "dkn-nexus:secret:";

function isNativeRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invokeSecret<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export async function saveSecret(name: string, value: string): Promise<"native"> {
  const secret = value.trim();
  if (!secret) throw new Error("密钥不能为空。");
  if (isNativeRuntime()) {
    try {
      await invokeSecret("save_secret", { name, value: secret });
      const stored = await invokeSecret<string>("load_secret", { name });
      if (stored !== secret) throw new Error("写入后读取校验不一致。");
      return "native";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`本机加密保存失败：${detail}`);
    }
  }
  throw new Error("请在 DKN Nexus 桌面版中保存密钥；网页预览不会保存 API Key。");
}

export async function saveAgentImageSecret(providerId: string, endpointUrl: string, value: string): Promise<void> {
  if (!/^[a-f0-9]{32}$/.test(providerId)) throw new Error("图片服务 ID 无效。");
  const secret = value.trim();
  if (!secret) throw new Error("图片 API Key 不能为空。");
  if (!isNativeRuntime()) throw new Error("请在 DKN Nexus 桌面版中保存图片 API Key；网页预览不会保存密钥。");
  await invokeSecret("save_agent_image_secret", { providerId, endpointUrl: endpointUrl.trim(), value: secret });
}

export async function hasAgentImageSecret(providerId: string): Promise<boolean> {
  if (!/^[a-f0-9]{32}$/.test(providerId) || !isNativeRuntime()) return false;
  try { return await invokeSecret<boolean>("has_agent_image_secret", { providerId }); } catch { return false; }
}

export async function saveAgentTextSecret(providerId: string, baseUrl: string, value: string): Promise<void> {
  if (!/^[a-f0-9]{32}$/.test(providerId)) throw new Error("文本服务 ID 无效。");
  const secret = value.trim();
  if (!secret) throw new Error("API Key 不能为空。");
  if (!isNativeRuntime()) throw new Error("请在 DKN Nexus 桌面版中保存 API Key；网页预览不会保存密钥。");
  await invokeSecret("save_agent_text_secret", { providerId, baseUrl: baseUrl.trim(), value: secret });
}

export async function hasAgentTextSecret(providerId: string): Promise<boolean> {
  if (!/^[a-f0-9]{32}$/.test(providerId) || !isNativeRuntime()) return false;
  try { return await invokeSecret<boolean>("has_agent_text_secret", { providerId }); } catch { return false; }
}

export async function deleteAgentTextSecret(providerId: string): Promise<void> {
  if (!/^[a-f0-9]{32}$/.test(providerId)) throw new Error("文本服务 ID 无效。");
  if (!isNativeRuntime()) throw new Error("请在 DKN Nexus 桌面版中删除 API Key。");
  await invokeSecret("delete_agent_text_secret", { providerId });
}

export async function loadSecret(name: string): Promise<string> {
  try { return await invokeSecret<string>("load_secret", { name }); }
  catch { return isNativeRuntime() ? "" : sessionStorage.getItem(`${SECRET_PREFIX}${name}`) ?? ""; }
}

export async function deleteSecret(name: string): Promise<void> {
  try { await invokeSecret("delete_secret", { name }); }
  catch { if (isNativeRuntime()) throw new Error("Windows 凭据删除失败。"); sessionStorage.removeItem(`${SECRET_PREFIX}${name}`); }
}
