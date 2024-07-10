/**
 * Module for working with and performing expansion of template strings
 * with `${var}`-style variable template expressions.
 */

import * as vscode from 'vscode';
import { createLogger } from './logging';
import { replaceAll, fixPaths, errorToString } from './util';
import * as nls from 'vscode-nls';
import { EnvironmentWithNull, EnvironmentUtils } from './environmentVariables';
import * as matchAll from 'string.prototype.matchall';

nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

const log = createLogger('expand');
export const envDelimiter: string = (process.platform === 'win32') ? ";" : ":";

/**
 * The required keys for expanding a string in CMake Tools.
 *
 * Unless otherwise specified, CMake Tools guarantees that certain variable
 * references will be available when performing an expansion. Those guaranteed
 * variables are specified as properties on this interface.
 */
interface RequiredExpansionContextVars {
    generator: string;
    workspaceFolder: string;
    workspaceFolderBasename: string;
    sourceDir: string;
    workspaceHash: string;
    workspaceRoot: string;
    workspaceRootFolderName: string;
    userHome: string;
}

export interface KitContextVars extends RequiredExpansionContextVars {
    [key: string]: string;
    buildType: string;
    buildKit: string;
    buildKitVendor: string;
    buildKitTriple: string;
    buildKitVersion: string;
    buildKitHostOs: string;
    buildKitTargetOs: string;
    buildKitTargetArch: string;
    buildKitVersionMajor: string;
    buildKitVersionMinor: string;
}

export interface PresetContextVars extends RequiredExpansionContextVars {
    [key: string]: string;
    sourceDir: string;
    sourceParentDir: string;
    sourceDirName: string;
    presetName: string;
    fileDir: string;
}

export interface MinimalPresetContextVars extends RequiredExpansionContextVars {
    [key: string]: string;
}

/**
 * Options to control the behavior of `expandString`.
 */
export interface ExpansionOptions {
    /**
     * Plain `${variable}` style expansions.
     */
    vars: KitContextVars | PresetContextVars | MinimalPresetContextVars;
    /**
     * Override the values used in `${env:var}`-style and `${env.var}`-style expansions.
     *
     * Note that setting this property will disable expansion of environment
     * variables for the running process. Only environment variables in this key
     * will be expanded.
     */
    envOverride?: EnvironmentWithNull;
    /**
     * Variables for `${variant:var}`-style expansions.
     */
    variantVars?: { [key: string]: string };
    /**
     * Do expandString recursively if set to true.
     */
    recursive?: boolean;
    /**
     * Support commands by default
     */
    doNotSupportCommands?: boolean;
}

export interface ExpansionErrorHandling {
    error: ExpansionError | undefined;
}

export enum ExpansionError {
    errorFromCircularReference = "circularReference",
    maxRecursion = "maxRecursion"
}

/**
 * Replace ${variable} references in the given string with their corresponding
 * values.
 * @param input The input string
 * @param opts Options for the expansion process
 * @returns A string with the variable references replaced
 */
export async function expandString<T>(input: string | T, opts: ExpansionOptions, _errorHandler: ExpansionErrorHandling | undefined = undefined): Promise<string | T> {
    if (typeof input !== 'string') {
        return input;
    }

    const inputString = input as string;
    try {

        const maxRecursion = 10;
        let result = inputString;
        let didReplacement = false;
        let circularReference: string | undefined;

        let i = 0;
        do {
            // TODO: consider a full circular reference check?
            const expansion = await expandStringHelper(result, opts);
            result = expansion.result;
            didReplacement = expansion.didReplacement;
            circularReference = expansion.circularReference;
            i++;
        } while (i < maxRecursion && opts.recursive && didReplacement && !circularReference);

        if (circularReference) {
            log.error(localize('circular.variable.reference', 'Circular variable reference found: {0}', circularReference));
            if (_errorHandler) {
                _errorHandler.error = ExpansionError.errorFromCircularReference;
            }
        } else if (i === maxRecursion) {
            log.error(localize('reached.max.recursion', 'Reached max string expansion recursion. Possible circular reference.'));
            if (_errorHandler) {
                _errorHandler.error = ExpansionError.maxRecursion;
            }
        }

        return replaceAll(result, '${dollar}', '$');
    } catch (e) {
        log.warning(localize('exception.expanding.string', 'Exception while expanding string {0}: {1}', inputString, errorToString(e)));
    }

    return input;
}

// Regular expression for variable value (between the variable suffix and the next ending curly bracket):
// .+? matches any character (except line terminators) between one and unlimited times,
// as few times as possible, expanding as needed (lazy)
const varValueRegexp = ".+?";

async function expandStringHelper(input: string, opts: ExpansionOptions) {
    const envPreNormalize = opts.envOverride ? opts.envOverride : process.env;
    const env = EnvironmentUtils.create(envPreNormalize);
    const replacements = opts.vars;
    replacements.sourceDirectory = replacements.sourceDir;
    let circularReference: string | undefined;
    let expansionOccurred: boolean = false;

    // We accumulate a list of substitutions that we need to make, preventing
    // recursively expanding or looping forever on bad replacements
    const subs = new Map<string, string>();

    const varRegex = /\$\{(\w+)\}/g;
    for (const mat of matchAll(input, varRegex)) {
        expansionOccurred = true;
        const full = mat[0];
        const key = mat[1];
        if (key !== 'dollar') {
            // Replace dollar sign at the very end of the expanding process
            const replacement = replacements[key];
            if (!replacement) {
                log.warning(localize('invalid.variable.reference', 'Invalid variable reference {0} in string: {1}', full, input));
            } else {
                subs.set(full, replacement);
            }
        }
    }

    const envRegex1 = RegExp(`\\$\\{env:(${varValueRegexp})\\}`, "g");
    for (const mat of matchAll(input, envRegex1)) {
        expansionOccurred = true;
        const full = mat[0];
        const varName = mat[1];
        const replacement = fixPaths(env[varName]) || '';
        subs.set(full, replacement);
    }

    const envRegex2 = RegExp(`\\$\\{env\\.(${varValueRegexp})\\}`, "g");
    for (const mat of matchAll(input, envRegex2)) {
        expansionOccurred = true;
        const full = mat[0];
        const varName = mat[1];
        const replacement = fixPaths(env[varName]) || '';
        subs.set(full, replacement);
    }

    const envRegex3 = RegExp(`\\$env\\{(${varValueRegexp})\\}`, "g");
    for (const mat of matchAll(input, envRegex3)) {
        expansionOccurred = true;
        const full = mat[0];
        const varName = mat[1];
        const replacement: string = fixPaths(env[varName]) || '';
        // Avoid replacing an env variable by itself, e.g. PATH:env{PATH}.
        const envRegex4 = RegExp(`\\$env\\{(${varValueRegexp})\\}`, "g");
        const mat2 = envRegex4.exec(replacement);
        const varNameReplacement = mat2 ? mat2[1] : undefined;
        if (varNameReplacement && varNameReplacement === varName) {
            circularReference = `\"${varName}\" : \"${input}\"`;
            break;
        }
        subs.set(full, replacement);
    }

    getParentEnvSubstitutions(input, subs);

    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        const folderRegex = RegExp(`\\$\\{workspaceFolder:(${varValueRegexp})\\}`, "g");
        for (const mat of matchAll(input, folderRegex)) {
            const full = mat[0];
            const folderName = mat[1];
            const f = vscode.workspace.workspaceFolders.find(folder => folder.name.toLocaleLowerCase() === folderName.toLocaleLowerCase());
            if (f) {
                expansionOccurred = true;
                subs.set(full, f.uri.fsPath);
            }
        }
    }

    if (opts.variantVars) {
        const variants = opts.variantVars;
        const variantRegex = RegExp(`\\$\\{variant:(${varValueRegexp})\\}`, "g");
        for (const mat of matchAll(input, variantRegex)) {
            expansionOccurred = true;
            const full = mat[0];
            const varName = mat[1];
            const replacement = variants[varName] || '';
            subs.set(full, replacement);
        }
    }

    const commandRegex = RegExp(`\\$\\{command:(${varValueRegexp})\\}`, "g");
    for (const mat of matchAll(input, commandRegex)) {
        if (opts.doNotSupportCommands) {
            log.warning(localize('command.not.supported', 'Commands are not supported for string: {0}', input));
            break;
        }
        const full = mat[0];
        const command = mat[1];
        if (subs.has(full)) {
            continue;  // Don't execute commands more than once per string
        }
        try {
            expansionOccurred = true;
            const result = await vscode.commands.executeCommand(command, opts.vars.workspaceFolder);
            subs.set(full, `${result}`);
        } catch (e) {
            log.warning(localize('exception.executing.command', 'Exception while executing command {0} for string: {1} {2}', command, input, errorToString(e)));
        }
    }

    if (expansionOccurred) {
        log.debug(localize('expand.expandstringhelper', 'expanded {0}', input));
    }

    return { ...substituteAll(input, subs), circularReference };
}

export async function expandStrings(inputs: string[], opts: ExpansionOptions): Promise<string[]> {
    const expandedInputs: string[] = [];
    for (const input of inputs) {
        const expandedInput: string = await expandString(input, opts);
        expandedInputs.push(expandedInput);
    }
    return expandedInputs;
}

export function substituteAll(input: string, subs: Map<string, string>) {
    let finalString = input;
    let didReplacement = false;
    subs.forEach((value, key) => {
        if (value !== key) {
            finalString = replaceAll(finalString, key, value);
            didReplacement = true;
        }
    });
    return { result: finalString, didReplacement };
}

export function getParentEnvSubstitutions(input: string, subs: Map<string, string>): Map<string, string> {
    const parentEnvRegex = RegExp(`\\$penv\\{(${varValueRegexp})\\}`, "g");
    for (const mat of matchAll(input, parentEnvRegex)) {
        const full = mat[0];
        const varName = mat[1];
        const replacement = fixPaths(process.env[varName]) || '';
        subs.set(full, replacement);
    }

    return subs;
}
