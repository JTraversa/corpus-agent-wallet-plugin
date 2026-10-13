// Shared constants and helpers for the corpusAI Agent Wallet plugin.
import { type CommandIO, CommandError, PluginCommand } from "@metamask/agent-wallet/plugin";
import { createPublicClient, http, parseAbi, type Address, type Hex, type PublicClient } from "viem";

export const FEED = "https://cloud.trycorpus.ai";

export const CHAINS = {
  143: { chainId: 143, name: "Monad", caip2: "eip155:143", usdc: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as Address, rpc: "https://rpc.monad.xyz", explorer: "https://monadexplorer.com" },
  10143: { chainId: 10143, name: "Monad Testnet", caip2: "eip155:10143", usdc: "0x0000000000000000000000000000000000000000" as Address, rpc: "https://testnet-rpc.monad.xyz", explorer: "https://testnet.monadexplorer.com" },
} as const;
export type ChainInfo = (typeof CHAINS)[keyof typeof CHAINS];

/** Deployed contracts; override with CORPUS_TOKEN / CORPUS_ORACLE or --token / --oracle. Filled after deployment (see corpus-monad/deployments.md). */
export const DEPLOYMENTS: Record<number, { token?: Address; oracle?: Address }> = {
  143: { token: (process.env.CORPUS_TOKEN as Address) || undefined, oracle: (process.env.CORPUS_ORACLE as Address) || undefined },
  10143: { token: (process.env.CORPUS_TOKEN as Address) || undefined, oracle: (process.env.CORPUS_ORACLE as Address) || undefined },
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
  /** Host-authenticated client when available, else the public Monad RPC. */
  protected client(chain: ChainInfo): PublicClient {
    try { if (this.ctx && typeof this.ctx.publicClient === "function") return this.ctx.publicClient(chain.chainId) as PublicClient; } catch { /* fall through */ }
    return createPublicClient({ transport: http(chain.rpc) });
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
    if (res.status !== "CONFIRMED" || !res.signature) throw new CommandError("SIGNING_FAILED", `Signature not produced: ${res.failureDescription || res.status}`, "Unlock the wallet and approve the signature request.");
    return res.signature as Hex;
  }
  protected async activeAddress(): Promise<Address> {
    const svc: any = this.ctx.accountService;
    const acct = await (svc.getActiveAccount?.() ?? svc.getSelectedAccount?.() ?? svc.getAccount?.());
    const addr = acct?.address ?? acct?.evmAddress ?? (typeof acct === "string" ? acct : undefined);
    if (!addr) throw new CommandError("NO_ACCOUNT", "No active EVM account in the Agent Wallet.", "Run `mm init` and `mm login`, then retry.");
    return addr as Address;
  }
  protected abstract readonly pluginCommandId: string;
}
