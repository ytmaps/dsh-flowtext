export declare const FLOWTEXT_VAULT_MODEL_PREFIX = "flowtext-vault:";
export interface FlowTextGatewayTarget {
    readonly vaultId: string;
    readonly vaultName: string;
    readonly vaultPath: string;
    readonly port: number;
    readonly baseUrl: string;
    readonly modelId: string;
}
export declare function flowTextVaultModelId(vaultId: string): string;
/** Read live owner-only records written by FlowText vault instances. */
export declare function listFlowTextGatewayTargets(directory?: string, now?: number): Promise<FlowTextGatewayTarget[]>;
export declare class FlowTextGatewayDiscovery {
    private readonly directory?;
    constructor(directory?: string | undefined);
    list(): Promise<FlowTextGatewayTarget[]>;
    resolve(modelId: string): Promise<FlowTextGatewayTarget>;
}
