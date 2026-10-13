import { type CommandIO, CommandError, InputFieldType, type InputSchema, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { recoverTypedDataAddress } from "viem";
import { CorpusCommand, FEED, resolveChain } from "../../corpus.js";

const inputs = {
  path: { type: InputFieldType.Text, flag: "path", message: "Feed path, e.g. /v1/index/fixing?ticker=CX.H100SXM.NEO", required: false, prompt: false, index: 0 },
  ticker: { type: InputFieldType.Text, flag: "ticker", message: "Index ticker (shortcut for /v1/index/fixing?ticker=…)", required: false, prompt: false },
  maxSpend: { type: InputFieldType.Text, flag: "max-spend", message: "Maximum USDC to pay for this call (default 0.05)", required: false, prompt: false },
  chainId: { type: InputFieldType.Text, flag: "chain-id", message: "Monad chain id (143)", required: false, prompt: false },
} satisfies InputSchema;

type PriceResult = { url: string; status: number; paid: boolean; amountUsdc?: string; network?: string; payer?: string; data: unknown };

export default class CorpusPrice extends CorpusCommand<PriceResult> {
  static override description = "Buy a cloud or GPU price from corpusAI Cloud Pricing, paying the x402 402 in USDC on Monad through the Agent Wallet.";
  static override examples = [
    "<%= config.bin %> corpus price --ticker CX.H100SXM.NEO --json",
    "<%= config.bin %> corpus price /v1/spot/latest?instance=p5.48xlarge&region=us-east-1 --json",
    "<%= config.bin %> corpus price /v1/index/tickers --json",
  ];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "corpus:price";

  async execute(io: CommandIO): Promise<PriceResult> {
    const { path, ticker, maxSpend, chainId } = await io.resolveInputs(inputs);
    const chain = resolveChain(chainId);
    if (chain.chainId !== 143) throw new CommandError("UNSUPPORTED_CHAIN", "x402 on the feed settles on Monad mainnet (143).", "Omit --chain-id or pass 143.");
    const p = path || (ticker ? `/v1/index/fixing?ticker=${encodeURIComponent(ticker)}` : "/v1/index/fixing?ticker=CX.H100SXM.NEO");
    if (!p.startsWith("/")) throw new CommandError("INVALID_INPUT", "path must start with /", "Example: /v1/index/fixing?ticker=CX.H100SXM.NEO");
    const url = FEED + p;
    const maxUsdc = BigInt(Math.round(Number(maxSpend || "0.05") * 1e6));

    io.emit(`GET ${url}`);
    const first = await fetch(url, { headers: { Accept: "application/json" } });
    if (first.status !== 402) return { url, status: first.status, paid: false, data: await first.json().catch(() => null) };

    const body: any = await first.clone().json().catch(() => null);
    const client = new x402Client(); const httpClient = new x402HTTPClient(client);
    const headerVal = first.headers.get("PAYMENT-REQUIRED");
    const paymentRequired: any = headerVal ? httpClient.getPaymentRequiredResponse((n) => first.headers.get(n), body) : { x402Version: body?.x402Version || 2, accepts: body?.accepts || [] };
    const req = (paymentRequired.accepts || []).find((a: any) => a.scheme === "exact" && a.network === chain.caip2 && String(a.asset).toLowerCase() === chain.usdc.toLowerCase());
    if (!req) throw new CommandError("NO_MONAD_OFFER", "The 402 carries no USDC offer on Monad.", "Check https://cloud.trycorpus.ai/x402 for the current rails.");
    const amount = BigInt(req.amount);
    if (amount > maxUsdc) throw new CommandError("MAX_SPEND_EXCEEDED", `This call costs ${Number(amount) / 1e6} USDC, above --max-spend ${Number(maxUsdc) / 1e6}.`, "Raise --max-spend to allow it.");
    req.maxTimeoutSeconds = Math.min(Number(req.maxTimeoutSeconds) || 300, 300);

    const payer = await this.activeAddress();
    let lastTyped: any = null; let lastSig: `0x${string}` | null = null;
    const signer = { address: payer, signTypedData: async (td: any) => { lastTyped = td; lastSig = await this.signTyped(io, chain, { domain: td.domain, types: td.types, primaryType: td.primaryType, message: td.message }); return lastSig; } };
    registerExactEvmScheme(client, { signer: signer as any, networks: [req.network] });
    io.emit(`Paying ${Number(amount) / 1e6} USDC on ${chain.name} to ${req.payTo} through the Agent Wallet…`);
    const payload = await httpClient.createPaymentPayload({ ...paymentRequired, accepts: [req] });
    if (!lastTyped || !lastSig) throw new CommandError("SIGNING_FAILED", "No EIP-712 authorization was produced.", "Approve the signature in MetaMask and retry.");
    if (String(lastTyped.domain?.verifyingContract).toLowerCase() !== chain.usdc.toLowerCase() || BigInt(lastTyped.message?.value ?? lastTyped.message?.amount ?? 0) !== amount || String(lastTyped.message?.to).toLowerCase() !== String(req.payTo).toLowerCase())
      throw new CommandError("SIGNATURE_MISMATCH", "The signed authorization does not match the 402 offer.", "Retry; if it persists, report it to hello@trycorpus.ai.");
    const recovered = await recoverTypedDataAddress({ ...lastTyped, signature: lastSig });
    if (recovered.toLowerCase() !== payer.toLowerCase()) throw new CommandError("PAYER_MISMATCH", `Signature recovered to ${recovered}, not the active account ${payer}.`, "Select the right account in MetaMask.");

    const paid = await fetch(url, { headers: { Accept: "application/json", ...httpClient.encodePaymentSignatureHeader(payload) } });
    const data = await paid.json().catch(() => null);
    return { url, status: paid.status, paid: paid.ok && Boolean(paid.headers.get("PAYMENT-RESPONSE") || paid.headers.get("X-PAYMENT-RESPONSE")), amountUsdc: (Number(amount) / 1e6).toFixed(6), network: req.network, payer, data };
  }
  override successHint(r: PriceResult): string { return r.paid ? `Paid ${r.amountUsdc} USDC on Monad; price returned.` : `HTTP ${r.status}, no payment made.`; }
}
