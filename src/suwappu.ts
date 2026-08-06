const API_BASE_URL = (process.env.SUWAPPU_API_URL ?? "https://api.suwappu.bot").replace(/\/$/, "");

export interface QuoteResult {
  id: string;
  toAmount: string;
  dex: string;
}

export interface SwapSimulation {
  success?: boolean;
  reason?: string;
  [key: string]: unknown;
}

export interface ManagedSwapResult {
  swapId: string;
  status: string;
  txHash?: string;
  pollUrl?: string;
}

async function request<T>(
  apiKey: string,
  method: string,
  path: string,
  json?: unknown,
): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Suwappu API error ${response.status}: ${text || response.statusText}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export async function getQuote(
  apiKey: string,
  args: {
    from: string;
    to: string;
    amount: number;
    chain: string;
    walletAddress?: string;
  },
): Promise<QuoteResult> {
  const payload = await request<{
    quote_id?: string;
    amount_out?: string | number;
    dex?: string;
  }>(apiKey, "POST", "/v1/agent/quote", {
    from_token: args.from,
    to_token: args.to,
    amount: String(args.amount),
    chain: args.chain,
    wallet_address: args.walletAddress,
  });

  if (!payload.quote_id || payload.amount_out === undefined) {
    throw new Error("Malformed quote response");
  }

  return {
    id: payload.quote_id,
    toAmount: String(payload.amount_out),
    dex: String(payload.dex ?? ""),
  };
}

export function simulateSwap(
  apiKey: string,
  quoteId: string,
  walletAddress: string,
): Promise<SwapSimulation> {
  return request(apiKey, "POST", "/v1/agent/swap/simulate", {
    quote_id: quoteId,
    wallet_address: walletAddress,
  });
}

export async function executeManagedSwap(
  apiKey: string,
  quoteId: string,
): Promise<ManagedSwapResult> {
  const payload = await request<{
    swap_id?: string | number;
    status?: string;
    tx_hash?: string | null;
    tracking?: { poll_url?: string };
  }>(apiKey, "POST", "/v1/agent/swap/execute", { quote_id: quoteId });

  if (payload.swap_id === undefined || typeof payload.status !== "string") {
    throw new Error("Malformed managed swap response");
  }

  return {
    swapId: String(payload.swap_id),
    status: payload.status,
    ...(payload.tx_hash ? { txHash: payload.tx_hash } : {}),
    ...(payload.tracking?.poll_url ? { pollUrl: payload.tracking.poll_url } : {}),
  };
}
