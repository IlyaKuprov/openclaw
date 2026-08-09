const DISCORD_PROVIDER_ENDPOINT_ENV = {
  restApiBaseUrl: "DISCORD_REST_API_BASE_URL",
  gatewayBotUrl: "DISCORD_GATEWAY_BOT_URL",
  gatewayOrigin: "DISCORD_GATEWAY_ORIGIN",
} as const;

type DiscordProviderEndpointDescriptor = Readonly<{
  restApiBaseUrl: string;
  gatewayBotUrl: string;
  gatewayOrigin: string;
}>;

export async function initializeDiscordProviderEndpointForTest(
  descriptor: DiscordProviderEndpointDescriptor,
): Promise<void> {
  const { initializeDiscordProviderEndpointFromEnv } = await import("./provider-endpoint.js");
  initializeDiscordProviderEndpointFromEnv({
    [DISCORD_PROVIDER_ENDPOINT_ENV.restApiBaseUrl]: descriptor.restApiBaseUrl,
    [DISCORD_PROVIDER_ENDPOINT_ENV.gatewayBotUrl]: descriptor.gatewayBotUrl,
    [DISCORD_PROVIDER_ENDPOINT_ENV.gatewayOrigin]: descriptor.gatewayOrigin,
  });
}
