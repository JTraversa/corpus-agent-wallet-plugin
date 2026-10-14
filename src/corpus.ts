// Shared constants and helpers for the corpusAI Agent Wallet plugin.
import { type CommandIO, CommandError, PluginCommand } from "@metamask/agent-wallet/plugin";
import { createPublicClient, http, parseAbi, type Address, type Hex, type PublicClient } from "viem";

export const FEED = "https://cloud.trycorpus.ai";

export const CHAINS = {
  143: { chainId: 143, name: "Monad", caip2: "eip155:143", usdc: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as Address, rpc: "https://rpc.monad.xyz", explorer: "https://monadexplorer.com" },
  10143: { chainId: 10143, name: "Monad Testnet", caip2: "eip155:10143", usdc: "0x966ca2c9a5c3927C6AB1Ccd7068E13e698458A2F" as Address /* mock USDC used by the testnet deployment */, rpc: "https://testnet-rpc.monad.xyz", explorer: "https://testnet.monadexplorer.com" },
} as const;
export type ChainInfo = (typeof CHAINS)[keyof typeof CHAINS];

/** Deployed contracts; override with CORPUS_TOKEN / CORPUS_ORACLE or --token / --oracle. Filled after deployment (see corpus-monad/deployments.md). */
export const DEPLOYMENTS: Record<number, { token?: Address; oracle?: Address }> = {
  143: { token: (process.env.CORPUS_TOKEN as Address) || undefined, oracle: (process.env.CORPUS_ORACLE as Address) || undefined },
  10143: {
    token: (process.env.CORPUS_TOKEN as Address) || "0xc6B96de257d3E1285080Fdb43BeF60DcbeDcd70c",
    oracle: (process.env.CORPUS_ORACLE as Address) || "0x0452ABd329B6C4006ECCdA9FBb5c9e87F5d73744",
  },
};

export function resolveChain(input: unknown): ChainInfo {
  if (input === undefined || input === null || input === "") return CHAINS[143];
  const n = Number(input);
  if (n === 143 || n === 10143) return CHAINS[n];
  throw new CommandError("UNSUPPORTED_CHAIN", `Chain ${String(input)} is not supported; use 143 (Monad) or 10143 (Monad Testnet).`, "Pass --chain-id 143 or --chain-id 10143.");
}

export function requireAddress(v: unknown, what: string, fallback?: Address): Address {
  const s = typeof v === "string" && v ? v : fallback;
  if (!s || !/^0x[0-9a-fA-F]{40}$/.test(s)) throw new CommandError("MISSING_ADDRESS", `${what} address is not set.`, `Pass --${what} 0x… or set CORPUS_${what.toUpperCase()}.`);
  return s as Address;
}

export const tokenAbi = parseAbi([
  "function usdc() view returns (address)",
  "function typeCount() view returns (uint256)",
  "function types(uint256) view returns (string slug, string label, uint256 monthlyUsdc, uint256 principalUsdc, uint256 priceUsdc, bool active)",
  "function totalSupply(uint256 id) view returns (uint256)",
  "function balanceOf(address, uint256) view returns (uint256)",
  "function mint(uint256 id, uint256 qty) returns (uint256)",
  "function redeem(uint256 id, uint256 qty, bytes32 accountRef)",
]);
/** Kuru order books on Monad (docs.kuru.io/contracts/Contract-addresses). The cS1-256/USDC market is on testnet:
 *  mainnet market creation on Kuru's Router is owner-gated, listing requested. Override with --market / KURU_MARKET. */
export const KURU: Record<number, { margin: Address; market?: Address }> = {
  143: { margin: "0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5", market: (process.env.KURU_MARKET as Address) || undefined },
  10143: { margin: "0xd029C2D98ff85D8F64799017fE00a59B1159CE02", market: (process.env.KURU_MARKET as Address) || "0x9178E699E33c0253E39d769dA0A7B87cfb1346c5" },
};
export const kuruBookAbi = parseAbi([
  "function getMarketParams() view returns (uint32 pricePrecision, uint96 sizePrecision, address base, uint256 baseDecimals, address quote, uint256 quoteDecimals, uint32 tickSize, uint96 minSize, uint96 maxSize, uint256 takerFeeBps, uint256 makerFeeBps)",
  "function getL2Book() view returns (bytes)",
  "function addBuyOrder(uint32 price, uint96 size, bool postOnly)",
  "function addSellOrder(uint32 price, uint96 size, bool postOnly)",
  "function placeAndExecuteMarketBuy(uint96 quoteSize, uint256 minAmountOut, bool isMargin, bool isFillOrKill) returns (uint256)",
  "function placeAndExecuteMarketSell(uint96 size, uint256 minAmountOut, bool isMargin, bool isFillOrKill) returns (uint256)",
]);
export const kuruMarginAbi = parseAbi([
  "function deposit(address user, address token, uint256 amount)",
  "function getBalance(address user, address token) view returns (uint256)",
]);
export const wrapperAbi = parseAbi([
  "function token() view returns (address)",
  "function id() view returns (uint256)",
  "function symbol() view returns (string)",
  "function wrap(uint256 qty)",
]);
export const erc1155ApprovalAbi = parseAbi([
  "function isApprovedForAll(address, address) view returns (bool)",
  "function setApprovalForAll(address, bool)",
]);

export type KuruMarket = { address: Address; pricePrecision: bigint; sizePrecision: bigint; base: Address; baseDecimals: number; quote: Address; quoteDecimals: number; tickSize: bigint; minSize: bigint; maxSize: bigint; takerFeeBps: number; makerFeeBps: number };
export type Level = { price: number; size: number };

export async function kuruMarket(c: PublicClient, address: Address): Promise<KuruMarket> {
  const p = await c.readContract({ address, abi: kuruBookAbi, functionName: "getMarketParams" });
  return { address, pricePrecision: BigInt(p[0]), sizePrecision: p[1], base: p[2], baseDecimals: Number(p[3]), quote: p[4], quoteDecimals: Number(p[5]), tickSize: BigInt(p[6]), minSize: p[7], maxSize: p[8], takerFeeBps: Number(p[9]), makerFeeBps: Number(p[10]) };
}

/** Resting limit orders from getL2Book: a block number, then (price, size) pairs for bids until a zero price, then asks. */
export async function kuruBook(c: PublicClient, m: KuruMarket): Promise<{ block: number; bids: Level[]; asks: Level[] }> {
  const data = (await c.readContract({ address: m.address, abi: kuruBookAbi, functionName: "getL2Book" })).slice(2);
  const word = (i: number) => BigInt("0x" + data.slice(i * 64, i * 64 + 64));
  const words = data.length / 64; let i = 1; const sides: Level[][] = [[], []];
  for (const side of sides) {
    while (i < words) { const price = word(i++); if (price === 0n) break; const size = word(i++); side.push({ price: Number(price) / Number(m.pricePrecision), size: Number(size) / Number(m.sizePrecision) }); }
  }
  sides[0].sort((a, b) => b.price - a.price); sides[1].sort((a, b) => a.price - b.price);
  return { block: Number(word(0)), bids: sides[0], asks: sides[1] };
}

/** Decimal string or number to fixed-point units, truncating extra digits (as the Kuru SDK does). */
export function toUnits(v: string | number, unit: bigint): bigint {
  const digits = unit.toString().length - 1; const [i, f = ""] = String(v).split(".");
  return BigInt(i || "0") * unit + BigInt((f + "0".repeat(digits)).slice(0, digits) || "0");
}

export const oracleAbi = parseAbi([
  "function latest(string ticker) view returns ((uint256 valueE18,uint32 n,uint64 postedAt,string day,string methodology))",
  "function publisher() view returns (address)",
]);
export const erc20Abi = parseAbi([
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

export abstract class CorpusCommand<T = void> extends PluginCommand<T> {
  /** Host-authenticated client when available, else the public Monad RPC. The host's RPC proxy rejects Monad
   *  testnet ("Invalid chainId"), so testnet reads always use the public endpoint. */
  protected client(chain: ChainInfo): PublicClient {
    try { if (chain.chainId !== 10143 && this.ctx && typeof this.ctx.publicClient === "function") return this.ctx.publicClient(chain.chainId) as PublicClient; } catch { /* fall through */ }
    // The public Monad RPCs allow 15 requests a second; back off and retry instead of failing the command.
    return createPublicClient({ transport: http(chain.rpc, { retryCount: 6, retryDelay: 400 }) });
  }
  /** Submit a transaction through the Agent Wallet (policy-gated, may pause for MFA). */
  protected async sendTx(io: CommandIO, chain: ChainInfo, to: Address, data: Hex, value = 0n): Promise<Hex> {
    const executor = await this.ctx.walletExecutor(io, this.pluginCommandId);
    const res: any = await executor({ kind: "transaction", chainId: chain.chainId, transaction: { to, data, value } } as any, { signal: io.signal } as any);
    if ((res.status !== "CONFIRMED" && res.status !== "SUBMITTED") || !res.hash) throw new CommandError("TRANSACTION_FAILED", `Transaction did not confirm: ${res.failureDescription || res.status}`, "Check the wallet's MON balance and approvals, then retry once you have confirmed it did not land.");
    return res.hash as Hex;
  }
  /** Sign EIP-712 typed data through the Agent Wallet. */
  protected async signTyped(io: CommandIO, chain: ChainInfo, typedData: any): Promise<Hex> {
    const executor = await this.ctx.walletExecutor(io, this.pluginCommandId);
    const res: any = await executor({ kind: "typed-data", chainId: chain.chainId, typedData } as any, { signal: io.signal } as any);
    // The server wallet answers typed-data requests with status SIGNED; older hosts used CONFIRMED.
    const sig = res.signature ?? res.result?.signature ?? res.data?.signature;
    if ((res.status !== "SIGNED" && res.status !== "CONFIRMED") || !sig) throw new CommandError("SIGNING_FAILED", `Signature not produced: ${res.failureDescription || res.status}${sig ? "" : ` (fields: ${Object.keys(res).join(",")})`}`, "Unlock the wallet and approve the signature request.");
    return sig as Hex;
  }
  protected async activeAddress(): Promise<Address> {
    const svc: any = this.ctx.accountService;
    const acct = await (svc.getActiveAccount?.() ?? svc.getSelectedAccount?.() ?? svc.getAccount?.());
    let addr = acct?.address ?? acct?.evmAddress ?? (typeof acct === "string" ? acct : undefined);
    if (!addr) {
      // Agent Wallet 7.x exposes the wallet list: getAccounts() -> addresses, getWallets() -> { address, namespace }.
      const isEvm = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
      const listed: unknown[] = [...((await svc.getAccounts?.()) ?? []), ...(((await svc.getWallets?.("evm")) ?? (await svc.getWallets?.()) ?? []) as any[]).map((w: any) => w?.address)];
      addr = listed.find(isEvm);
    }
    if (!addr) {
      // Agent Wallet 7.x keeps the selected wallet in its local state: { selectedWallet: { namespace, ref: { address } } }.
      const st: any = await (this.ctx as any).walletStateManager?.read?.();
      const sel = st?.selectedWallet; const evm = (a: unknown) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
      addr = (sel?.namespace === "evm" && evm(sel?.ref?.address)) ? sel.ref.address
        : [...(st?.remoteWallets ?? []), ...(st?.byokWallets ?? [])].find((w: any) => w?.namespace === "evm" && evm(w?.address))?.address;
    }
    if (!addr) throw new CommandError("NO_ACCOUNT", "No active EVM account in the Agent Wallet.", "Run `mm init` and `mm login`, then retry.");
    return addr as Address;
  }
  protected abstract readonly pluginCommandId: string;
}
