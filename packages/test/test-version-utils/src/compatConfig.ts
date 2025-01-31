/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import nconf from "nconf";
import { ITestObjectProvider } from "@fluidframework/test-utils";
import { TestDriverTypes } from "@fluidframework/test-driver-definitions";
import { getVersionedTestObjectProvider } from "./compatUtils";
import { ensurePackageInstalled } from "./testApi";
import { pkgVersion } from "./packageVersion";
import { resolveVersion } from "./versionUtils";

/**
 * Different kind of compat version config
 */
enum CompatKind {
    None = "None",
    Loader = "Loader",
    NewLoader = "NewLoader",
    Driver = "Driver",
    NewDriver = "NewDriver",
    ContainerRuntime = "ContainerRuntime",
    NewContainerRuntime = "NewContainerRuntime",
    DataRuntime = "DataRuntime",
    NewDataRuntime = "NewDataRuntime",
    LoaderDriver = "LoaderDriver",
}

/*
 * Generate configuration combinations for a particular compat version
 */

interface CompatConfig {
    name: string,
    kind: CompatKind,
    compatVersion: number | string,
    loader?: string | number,
    driver?: string | number,
    containerRuntime?: string | number,
    dataRuntime?: string | number,
}

// N, N - 1, and N - 2
const defaultVersions = [0, -1, -2];
// we are currently supporting 0.39 long-term
const LTSVersions = ["^0.39.0"];

function genConfig(compatVersion: number | string): CompatConfig[] {
    if (compatVersion === 0) {
        return [{
            // include the base version if it is not the same as the package version and it is not the test build
            name: `Non-Compat${baseVersion !== pkgVersion ? ` v${baseVersion}` : ""}`,
            kind: CompatKind.None,
            compatVersion: 0,
        }];
    }

    const allOld = {
        loader: compatVersion,
        driver: compatVersion,
        containerRuntime: compatVersion,
        dataRuntime: compatVersion,
    };

    const compatVersionStr = typeof compatVersion === "string" ? compatVersion : `N${compatVersion}`;
    return [
        {
            name: `compat ${compatVersionStr} - old loader`,
            kind: CompatKind.Loader,
            compatVersion,
            loader: compatVersion,
        },
        {
            name: `compat ${compatVersionStr} - new loader`,
            kind: CompatKind.NewLoader,
            compatVersion,
            ...allOld,
            loader: undefined,
        },
        {
            name: `compat ${compatVersionStr} - old driver`,
            kind: CompatKind.Driver,
            compatVersion,
            driver: compatVersion,
        },
        {
            name: `compat ${compatVersionStr} - new driver`,
            kind: CompatKind.NewDriver,
            compatVersion,
            ...allOld,
            driver: undefined,
        },
        {
            name: `compat ${compatVersionStr} - old container runtime`,
            kind: CompatKind.ContainerRuntime,
            compatVersion,
            containerRuntime: compatVersion,
        },
        {
            name: `compat ${compatVersionStr} - new container runtime`,
            kind: CompatKind.NewContainerRuntime,
            compatVersion,
            ...allOld,
            containerRuntime: undefined,
        },
        {
            name: `compat ${compatVersionStr} - old data runtime`,
            kind: CompatKind.DataRuntime,
            compatVersion,
            dataRuntime: compatVersion,
        },
        {
            name: `compat ${compatVersionStr} - new data runtime`,
            kind: CompatKind.NewDataRuntime,
            compatVersion,
            ...allOld,
            dataRuntime: undefined,
        },
    ];
}

const genLTSConfig = (compatVersion: number | string): CompatConfig[] => {
    return [
        {
            name: `compat LTS ${compatVersion} - old loader`,
            kind: CompatKind.Loader,
            compatVersion,
            loader: compatVersion,
        },
        {
            name: `compat LTS ${compatVersion} - old loader + old driver`,
            kind: CompatKind.LoaderDriver,
            compatVersion,
            driver: compatVersion,
            loader: compatVersion,
        },
    ];
};

/*
 * Parse the command line argument and environment variables.  Arguments take precedent.
 *   --compat <index> - choose a config to run (default: -1 for all)
 *   --reinstall      - force reinstallation of legacy versions
 *
 * Env:
 *   fluid__test__compat - same as --compat
 */
const options = {
    compatKind: {
        description: "Compat kind to run",
        choices: [
            CompatKind.None,
            CompatKind.Loader,
            CompatKind.NewLoader,
            CompatKind.Driver,
            CompatKind.NewDriver,
            CompatKind.ContainerRuntime,
            CompatKind.NewContainerRuntime,
            CompatKind.DataRuntime,
            CompatKind.NewDataRuntime,
            CompatKind.LoaderDriver,
        ],
        requiresArg: true,
        array: true,
    },
    compatVersion: {
        description: "Compat version to run",
        requiresArg: true,
        array: true,
        type: "string",
    },
    reinstall: {
        default: false,
        description: "Force compat package to be installed",
        boolean: true,
    },
    driver: {
        choices: [
            "tinylicious",
            "t9s",
            "routerlicious",
            "r11s",
            "odsp",
            "local",
        ],
        requiresArg: true,
    },
    r11sEndpointName: {
        type: "string",
    },
    baseVersion: {
        type: "string",
    },
};

nconf.argv({
    ...options,
    transform: (obj: { key: string, value: string }) => {
        if (options[obj.key] !== undefined) {
            obj.key = `fluid:test:${obj.key}`;
        }
        return obj;
    },
}).env({
    separator: "__",
    whitelist: [
        "fluid__test__compatKind",
        "fluid__test__compatVersion",
        "fluid__test__driver",
        "fluid__test__r11sEndpointName",
        "fluid__test__baseVersion",
    ],
    transform: (obj: { key: string, value: string }) => {
        if (!obj.key.startsWith("fluid__test__")) {
            return obj;
        }
        const key = obj.key.substring("fluid__test__".length);
        if (options[key] !== undefined && options[key].array) {
            try {
                obj.value = JSON.parse(obj.value);
            } catch {
                // ignore
            }
        }
        return obj;
    },
}).defaults(
    {
        fluid: {
            test: {
                compat: undefined,
                driver: "local",
                baseVersion: pkgVersion,
                r11sEndpointName: "r11s",
            },
        },
    },
);

const compatKind = nconf.get("fluid:test:compatKind") as CompatKind[] | undefined;
const compatVersions = nconf.get("fluid:test:compatVersion") as string[] | undefined;
const driver = nconf.get("fluid:test:driver") as TestDriverTypes;
const r11sEndpointName = nconf.get("fluid:test:r11sEndpointName") as string;
const baseVersion = resolveVersion(nconf.get("fluid:test:baseVersion") as string, false);

// set it in the env for parallel workers
if (compatKind) {
    process.env.fluid__test__compatKind = JSON.stringify(compatKind);
}
if (compatVersions) {
    process.env.fluid__test__compatVersion = JSON.stringify(compatVersions);
}
process.env.fluid__test__driver = driver;
process.env.fluid__test__r11sEndpointName = r11sEndpointName;
process.env.fluid__test__baseVersion = baseVersion;

let configList: CompatConfig[] = [];
if (!compatVersions || compatVersions.length === 0) {
    defaultVersions.forEach((value) => {
        configList.push(...genConfig(value));
    });
    LTSVersions.forEach((value) => {
        configList.push(...genLTSConfig(value));
    });
} else {
    compatVersions.forEach((value) => {
        if (value === "LTS") {
            LTSVersions.forEach((lts) => {
                configList.push(...genLTSConfig(lts));
            });
        } else {
            const num = parseInt(value, 10);
            if (num.toString() === value) {
                configList.push(...genConfig(num));
            } else {
                configList.push(...genConfig(value));
            }
        }
    });
}

if (compatKind !== undefined) {
    configList = configList.filter((value) => compatKind.includes(value.kind));
}

/*
 * Mocha Utils for test to generate the compat variants.
 */
function describeCompat(
    name: string,
    tests: (provider: () => ITestObjectProvider) => void,
    compatFilter?: CompatKind[],
) {
    let configs = configList;
    if (compatFilter !== undefined) {
        configs = configs.filter((value) => compatFilter.includes(value.kind));
    }

    describe(name, () => {
        for (const config of configs) {
            describe(config.name, () => {
                let provider: ITestObjectProvider;
                let resetAfterEach: boolean;
                before(async () => {
                    provider = await getVersionedTestObjectProvider(
                        baseVersion,
                        config.loader,
                        {
                            type: driver,
                            version: config.driver,
                            config: {
                                r11s: { r11sEndpointName },
                            },
                        },
                        config.containerRuntime,
                        config.dataRuntime,
                    );
                });
                tests((reset: boolean = true) => {
                    if (reset) {
                        provider.reset();
                        resetAfterEach = true;
                    }
                    return provider;
                });
                afterEach(() => {
                    if (resetAfterEach) {
                        provider.reset();
                    }
                });
            });
        }
    });
}

export function describeNoCompat(
    name: string,
    tests: (provider: (resetAfterEach?: boolean) => ITestObjectProvider) => void,
) {
    describeCompat(name, tests, [CompatKind.None]);
}

export function describeLoaderCompat(
    name: string,
    tests: (provider: (resetAfterEach?: boolean) => ITestObjectProvider) => void,
) {
    describeCompat(name, tests, [CompatKind.None, CompatKind.Loader]);
}

export function describeFullCompat(
    name: string,
    tests: (provider: (resetAfterEach?: boolean) => ITestObjectProvider) => void,
) {
    describeCompat(name, tests);
}

/*
 * Mocha start up to ensure legacy versions are installed
 */
export async function mochaGlobalSetup() {
    const versions = new Set(configList.map((value) => value.compatVersion));
    if (versions.size === 0) { return; }

    // Make sure we wait for all before returning, even if one of them has error.
    const installP = Array.from(versions.values()).map(
        async (value) => ensurePackageInstalled(baseVersion, value, nconf.get("fluid:test:reinstall")));

    let error: Error | undefined;
    for (const p of installP) {
        try {
            await p;
        } catch (e) {
            error = e;
        }
    }
    if (error) {
        throw error;
    }
}
