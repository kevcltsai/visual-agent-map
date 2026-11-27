import manifest from "../manifest.json";

declare const __VAM_RELEASE_BUILD__: boolean;

/** Version and release channel are injected into the plugin and standalone share page from one build identity. */
export const DISTRIBUTION_VERSION = manifest.version;
export const DISTRIBUTION_IS_RELEASE = __VAM_RELEASE_BUILD__;
