// Copyright 2021 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as readline from 'readline';
import * as log from './log';

const SHOW_UNRESOLVED_TERMINAL_LINKS = vscode.workspace.getConfiguration().get(
  'fuchsiAware.showUnresolvedTerminalLinks'
) ?? false;
const NORMALIZE_WORD_SEPARATORS = vscode.workspace.getConfiguration().get(
  'fuchsiAware.normalizeWordSeparators'
) ?? false;
const USE_HEURISTICS_TO_FIND_MORE_LINKS = vscode.workspace.getConfiguration().get(
  'useHeuristicsToFindMoreLinks'
) ?? false;

interface ComponentUrlTerminalLink extends vscode.TerminalLink {
  documentUri?: vscode.Uri;
}

export class Provider implements
  vscode.DocumentLinkProvider,
  vscode.TerminalLinkProvider,
  vscode.ReferenceProvider {

  static scheme = '*';

  private _baseUri: vscode.Uri;
  private _buildDir: string;
  private _packageAndComponentToManifestUri = new Map<string, vscode.Uri>();
  private _sourcePathToPackageAndComponent = new Map<string, string>();
  private _packageAndComponentToReferences = new Map<string, vscode.Location[]>();

  constructor(baseUri: vscode.Uri, buildDir: string) {
    this._baseUri = baseUri;
    this._buildDir = buildDir;
  }

  dispose() {
    this._packageAndComponentToManifestUri.clear();
    this._sourcePathToPackageAndComponent.clear();
    this._packageAndComponentToReferences.clear();
  }

  async init(): Promise<boolean> {
    const [gotLinks, gotReferences] = await Promise.all([
      this._getLinksToManifests(),
      this._getReferencesToManifests()
    ]);

    return gotLinks && gotReferences;
  }

  private async _getLinksToManifests(): Promise<boolean> {
    const componentTargetPathToPackageTargetPaths = new Map<string, string[]>();
    const componentTargetPathToComponentNameAndManifest = new Map<string, [string, string]>();
    const componentTargetPathToSubComponentTargets = new Map<string, string[]>();
    const packageTargetPathToPackageName = new Map<string, string>();

    const ninjaFileUri = this._baseUri.with({
      path: `${this._baseUri.path}/${this._buildDir}/toolchain.ninja`
    });
    const ninjaStream = fs.createReadStream(ninjaFileUri.fsPath);
    ninjaStream.on('error', (err) => {
      log.error(
        `Error reading the build dependencies from ${ninjaFileUri.fsPath}: '${err}'\n` +
        'You may need to re-run `fx set ...` and then reload your VS Code window.'
      );
    });
    const ninjaReadline = readline.createInterface(ninjaStream);

    let matchedAtLeastOneMetaFarExample = false;
    let matchedAtLeastOneManifestAndComponentExample = false;
    let matchedAtLeastOnePmBuildExample = false;

    for await (const line of ninjaReadline) {
      let result;
      if ((result = Provider.extractBuildDirPackageTargetAndComponents(line))) {
        const [targetBuildDir, packageTarget, componentTargets] = result;
        for (const componentTarget of componentTargets) {
          const packageTargetPath = `${targetBuildDir}:${packageTarget}`;
          let componentTargetPath;
          const [
            subComponentDir,
            subComponentTarget,
          ] = componentTarget.split('/');
          if (subComponentDir && subComponentTarget) {
            componentTargetPath = `${targetBuildDir}/${subComponentDir}:${subComponentTarget}`;
          } else {
            componentTargetPath = `${targetBuildDir}:${componentTarget}`;
          }
          if (!matchedAtLeastOneMetaFarExample) {
            matchedAtLeastOneMetaFarExample = true;
            log.debug(
              `Associating packages to components based on build dependencies in ` +
              `${ninjaFileUri.fsPath}, for example, package '${packageTarget}' will include at ` +
              `least the component built from ninja target '${componentTargetPath}'.`
            );
          }
          let packageTargetPaths = componentTargetPathToPackageTargetPaths.get(componentTargetPath);
          if (!packageTargetPaths) {
            packageTargetPaths = [];
            componentTargetPathToPackageTargetPaths.set(componentTargetPath, packageTargetPaths);
          }
          packageTargetPaths.push(packageTargetPath);
        }
      } else if ((result = Provider.extractSubComponents(line))) {
        const [
          manifestPath,
          targetBuildDir,
          componentTarget,
          subComponentTargets,
        ] = result;
        let componentTargetPath = `${targetBuildDir}:${componentTarget}`;
        for (const subComponentTarget of subComponentTargets) {
          if (!matchedAtLeastOneMetaFarExample) {
            matchedAtLeastOneMetaFarExample = true;
            log.debug(
              `Associating sub-components to components based on build dependencies in ` +
              `${ninjaFileUri.fsPath}, for example, '${componentTargetPath}' will include at ` +
              `least the component built from ninja target '${subComponentTarget}'.`
            );
          }
          let subComponentTargets =
            componentTargetPathToSubComponentTargets.get(componentTargetPath);
          if (!subComponentTargets) {
            subComponentTargets = [];
            componentTargetPathToSubComponentTargets.set(componentTargetPath, subComponentTargets);
          }
          subComponentTargets.push(subComponentTarget);
        }
      } else if (
        (result = Provider.extractManifestPathAndComponentFromCmcValidate(line, this._buildDir)) ||
        (result = Provider.extractManifestPathAndCmlComponent(line))
      ) {
        const [manifestPath, componentName, componentTargetPath] = result;
        if (!matchedAtLeastOneManifestAndComponentExample) {
          matchedAtLeastOneManifestAndComponentExample = true;
          log.debug(
            `Matching components to manifests based on build commands in ${ninjaFileUri.fsPath}, ` +
            `for example, '${manifestPath}' is the manifest source for ` +
            `a component to be named '${componentName}', and built via ninja target ` +
            `'${componentTargetPath}'.`
          );
        }

        if (log.DEBUG) {
          const existing = componentTargetPathToComponentNameAndManifest.get(componentTargetPath);
          if (existing) {
            const [origComponentName, origManifestPath] = existing;
            if (componentName !== origComponentName ||
              manifestPath !== origManifestPath) {
              log.debug(
                `WARNING (debug-only check): componentTargetPath '${componentTargetPath}' has ` +
                `duplicate entries:\n` +
                `${[origComponentName, origManifestPath]} != ` +
                `${[componentName, manifestPath]}`
              );
            }
          }
        }

        componentTargetPathToComponentNameAndManifest.set(
          componentTargetPath,
          [componentName, manifestPath]
        );
      } else if ((result = Provider.extractPackage(line))) {
        const [packageName, packageTargetPath] = result;
        if (!matchedAtLeastOnePmBuildExample) {
          matchedAtLeastOnePmBuildExample = true;
          log.debug(
            `Matching package targets to package names based on build commands in ` +
            `${ninjaFileUri.fsPath}, for example, '${packageTargetPath}' is the build target for ` +
            `a package to be named '${packageName}',`
          );
        }
        packageTargetPathToPackageName.set(packageTargetPath, packageName);
      }
    }

    if (!matchedAtLeastOneMetaFarExample) {
      log.error(
        `The ninja build file '${ninjaFileUri.fsPath}' did not contain any lines matching the ` +
        `expected pattern to identify components in a 'build meta.far' statement: \n\n` +
        `  metaFarRegEx = ${Provider._metaFarRegEx}\n`
      );
      return false;
    } else if (!matchedAtLeastOneManifestAndComponentExample) {
      log.error(
        `The ninja build file '${ninjaFileUri.fsPath}' did not contain any lines matching the ` +
        `expected pattern to identify components in a 'validate .cmx manifest' command: \n\n` +
        `  cmcValidateRefsRegEx = ${Provider._cmcValidateRefsRegEx}\n`
      );
      return false;
    } else if (!matchedAtLeastOnePmBuildExample) {
      log.error(
        `The ninja build file '${ninjaFileUri.fsPath}' did not contain any lines matching the ` +
        `expected pattern to identify components in a 'build package' command: \n\n` +
        `  pmBuildRegEx = ${Provider._pmBuildRegEx}\n`
      );
      return false;
    }

    for (
      let [componentTargetPath, packageTargetPaths]
      of componentTargetPathToPackageTargetPaths.entries()
    ) {
      for (const packageTargetPath of packageTargetPaths) {
        const packageName = packageTargetPathToPackageName.get(packageTargetPath);

        if (!packageName) {
          continue;
        }
        let componentNameAndManifest =
          componentTargetPathToComponentNameAndManifest.get(componentTargetPath);
        if (USE_HEURISTICS_TO_FIND_MORE_LINKS) {
          if (!componentNameAndManifest) {
            const targetWithoutComponentSuffix = componentTargetPath.replace(/:test_/, ':');
            if (targetWithoutComponentSuffix !== componentTargetPath) {
              componentTargetPath = targetWithoutComponentSuffix;
              componentNameAndManifest =
                componentTargetPathToComponentNameAndManifest.get(targetWithoutComponentSuffix);
            }
          }
          if (!componentNameAndManifest) {
            const targetWithoutComponentSuffix = componentTargetPath.replace(/_component$/, '');
            if (targetWithoutComponentSuffix !== componentTargetPath) {
              componentTargetPath = targetWithoutComponentSuffix;
              componentNameAndManifest =
                componentTargetPathToComponentNameAndManifest.get(targetWithoutComponentSuffix);
            }
          }
        }
        if (!componentNameAndManifest) {
          continue;
        }

        const [componentName, manifestPath] = componentNameAndManifest;
        const manifestUri = this._baseUri.with({ path: `${this._baseUri.path}/${manifestPath}` });
        this.addLink(packageName, componentName, manifestUri);

        const subComponentTargets =
          componentTargetPathToSubComponentTargets.get(componentTargetPath);
        if (subComponentTargets) {
          for (const subComponentTarget of subComponentTargets) {
            this.addLink(packageName, subComponentTarget, manifestUri);
          }
        }

        if (USE_HEURISTICS_TO_FIND_MORE_LINKS) {
          const nameWithoutComponentSuffix =
            componentName.replace(/_component(_generated_manifest)?$/, '');
          if (nameWithoutComponentSuffix !== componentName) {
            const targetWithoutComponentSuffix =
              componentTargetPath.replace(/_component(_generated_manifest)?$/, '');
            this.addLink(packageName, nameWithoutComponentSuffix, manifestUri);
          }
        }
      }
    }

    log.info('The data required by the DocumentLinkProvider is loaded.');
    return true;
  }

  // TODO(richkadel): These patterns are very fragile and subject to breakage when GN rules change.
  // Plus, since they only search the results from `fx set`, the results are limited to the packages
  // in the current set of dependencies (which isn't terrible, but not great for general browsing,
  // or to find a dependency.) Alternative 1: Find a better way to query the dependencies.
  // Alternative 2: Parse the BUILD.gn files (not recommended) And, consider running GN from the
  // extension, to generate a custom ninja result, with a broad set of targets, but if possible, a
  // narrow set of output targets (only those needed for the extension).

  private static _metaFarRegEx = new RegExp([
    /^\s*build\s*obj\/(?<targetBuildDir>[^.]+?)\/(?<packageTarget>[-\w]+)\/meta\.far/,
    /\s*(?<ignoreOtherOutputs>[^:]*)\s*:/,
    /\s*(?<ignoreNinjaRulename>[^\s]+)/,
    /\s*(?<ignoreInputs>[^|]+)\|/,
    /(?<dependencies>(.|\n)*)/,
  ].map(r => r.source).join(''));

  static extractBuildDirPackageTargetAndComponents(
    line: string
  ): [string, string, string[]] | undefined {
    const match = Provider._metaFarRegEx.exec(line);
    if (!match) {
      return;
    }
    const [
      , // full match
      targetBuildDir,
      packageTarget,
      , // ignoreOtherOutputs
      , // ignoreNinjaRulename
      , // ignoreInputs
      dependencies,
    ] = match;

    // Get all dependencies (global search)
    const componentTargets = [];
    const depRegEx = new RegExp([
      // CAUTION! Since this RegExp is built dynamically, and has at least one capturing group that
      // spans a wide swath (multiple lines, as structured here), the typical slash-contained
      // JavaScript RegExp syntax cannot be used. This means ALL BACKSLASHES MUST BE DOUBLED.
      // Be careful because many editors and parsers do not provide any warnings if you forget
      // to add the second backslash, but RegExp parsing will mysteriously stop working as
      // expected:
      `\\s*obj/${targetBuildDir}(?!/${packageTarget}\\.)/(?:(?:(?:(?<componentBuildSubdir>${packageTarget})_)?)|(?<subPackage>[^./]+))(?:/)?`,
      `(?:`,
      `(?:manifest.stamp)|`,
      `(?:metadata.stamp)|`,
      `(?:validate_manifests[^/]+.stamp)|`,
      `(?:[^\\s]+?_component_index.stamp)|`,
      `(?<componentTarget>[^/]+)(?:\\.manifest)?\\.stamp`,
      `)`,
    ].join(''), 'g');
    let depMatch;
    while ((depMatch = depRegEx.exec(dependencies))) {
      let [
        , // full match
        componentTargetPrefix,
        componentBuildSubdir,
        componentTarget,
      ] = depMatch;
      if (componentTarget === 'component' && componentTargetPrefix) {
        componentTarget = `${componentTargetPrefix}_${componentTarget}`;
      }
      if (componentTarget) {
        if (componentBuildSubdir) {
          componentTargets.push(`${componentBuildSubdir}/${componentTarget}`);
        } else if (componentTarget) {
          componentTargets.push(componentTarget);
        }
      }
    }

    return [
      targetBuildDir,
      packageTarget,
      componentTargets,
    ];
  }

  private static _buildCmxRegEx = new RegExp([
    /^\s*build\s*obj\/(?<manifestPath>(?<targetBuildDir>[^.]+?)\/(?<componentTarget>[-\w]+)\.cm[xl])/,
    /\s*(?<ignoreOtherOutputs>[^:]*)\s*:/,
    /\s*(?<ignoreNinjaRulename>[^\s]+)/,
    /\s*(?<ignoreInputs>[^|]+)\|/,
    /(?<dependencies>(.|\n)*)/,
  ].map(r => r.source).join(''));

  static extractSubComponents(
    line: string
  ): [string, string, string, string[]] | undefined {
    const match = Provider._buildCmxRegEx.exec(line);
    if (!match) {
      return;
    }
    const [
      , // full match
      manifestPath,
      targetBuildDir,
      componentTarget,
      , // ignoreOtherOutputs
      , // ignoreNinjaRulename
      , // ignoreInputs
      dependencies,
    ] = match;

    // Get all dependencies (global search)
    const subComponentTargets = [];
    const depRegEx = new RegExp([
      // CAUTION! Since this RegExp is built dynamically, and has at least one capturing group that
      // spans a wide swath (multiple lines, as structured here), the typical slash-contained
      // JavaScript RegExp syntax cannot be used. This means ALL BACKSLASHES MUST BE DOUBLED.
      // Be careful because many editors and parsers do not provide any warnings if you forget
      // to add the second backslash, but RegExp parsing will mysteriously stop working as
      // expected:
      `\\s*obj/${targetBuildDir}/`,
      `(?:`,
      `(?:${componentTarget}_check_includes)|`,
      `(?:${componentTarget}_cmc_validate_references)|`,
      `(?:${componentTarget}_manifest_resource)|`,
      `(?:${componentTarget}_merge)|`,
      `(?:${componentTarget}_validate)|`,
      `(?<subComponentTarget>[-\\w]+)`,
      `)`,
      `\\.stamp`,
    ].join(''), 'g');
    let depMatch;
    while ((depMatch = depRegEx.exec(dependencies))) {
      let [
        , // full match
        subComponentTarget,
      ] = depMatch;
      if (subComponentTarget) {
        subComponentTargets.push(subComponentTarget);
      }
    }

    return [
      manifestPath,
      targetBuildDir,
      componentTarget,
      subComponentTargets,
    ];
  }

  private static _cmcValidateRefsRegEx = new RegExp([
    /^\s*command\s*=(?:.|\n)*?host_\w+\/cmc\s/,
    // Note: The next regex is optional, and `prefComponentTarget` will be undefined, if
    // '_validate_manifests_' is not part of the `--stamp` string.
    /(?:(?:.|\n)*?--stamp\s+[^\s]*?_validate_manifests_(?<destComponentManifest>[-\w.]+?)?\.action\.stamp\b)?/,
    /(?:.|\n)*?\svalidate-references/,
    /(?:.|\n)*?--component-manifest\s+(?<pathRoot>(?:\.\.\/\.\.)|(?:obj))\/(?<manifestPath>[^\s]*\/(?<fallbackComponentName>[^/.]+)\.cm[xl]?)/,
    /(?:.|\n)*?--gn-label\s+\/\/(?<targetBuildDir>[^$]+)\$:/,
    /(?<fallbackComponentTarget>[-\w]+)?\b/,
  ].map(r => r.source).join(''));

  static extractManifestPathAndComponentFromCmcValidate(line: string, buildDir: string): [string, string, string] | undefined {
    const match = Provider._cmcValidateRefsRegEx.exec(line);
    if (!match) {
      return;
    }

    const [
      , // full match
      destComponentManifest,
      pathRoot,
      manifestPath,
      fallbackComponentName,
      targetBuildDir,
      fallbackComponentTarget,
    ] = match;

    let adjustedManifestPath = manifestPath;
    if (pathRoot !== '../..') {
      adjustedManifestPath = `../../${buildDir}/${manifestPath}`;
    }

    let componentTarget;
    let componentName;
    if (destComponentManifest) {
      componentTarget = destComponentManifest;
      componentName = componentTarget.replace(/\.cmx?$/, '');
    } else {
      componentTarget = fallbackComponentTarget.replace(
        /_cmc_validate_references$/,
        '',
      );
      componentName = fallbackComponentName;
    }

    const componentTargetPath = `${targetBuildDir}:${componentTarget}`;

    return [
      adjustedManifestPath,
      componentName,
      componentTargetPath,
    ];
  }

  private static _cmcCompileCmlRegEx = new RegExp([
    /^\s*command\s*=(?:.|\n)*?\/cmc\s+compile/,
    /\s+\.\.\/\.\.\/(?<manifestPath>[^.]+\.cml]?)/,
    /\s+--output\s+obj\/[^\s]+\/(?<componentName>[^/.]+)\.cm\s/,
    /(?:.|\n)*--depfile\s+obj\/(?<targetBuildDir>[^\s]+)\/(?<componentTarget>[^/.]+)(?:\.cm)?\.d/,
  ].map(r => r.source).join(''));

  static extractManifestPathAndCmlComponent(line: string): [string, string, string] | undefined {
    const match = Provider._cmcCompileCmlRegEx.exec(line);
    if (!match) {
      return;
    }

    const [
      , // full match
      manifestPath,
      componentName,
      targetBuildDir,
      componentTarget,
    ] = match;

    const componentTargetPath = `${targetBuildDir}:${componentTarget}`;

    return [
      manifestPath,
      componentName,
      componentTargetPath,
    ];
  }

  private static _pmBuildRegEx = new RegExp([
    /^\s*command\s*=(?:.|\n)*?\/pm/,
    /\s+-o\s+obj\/(?<targetBuildDir>[^\s]+)\/(?<packageTarget>[^\s]+)\s/,
    /(?:.|\n)*?-n\s+(?<packageName>[-\w]+)\s/,
  ].map(r => r.source).join(''));

  static extractPackage(line: string): [string, string] | undefined {
    const match = Provider._pmBuildRegEx.exec(line);
    if (!match) {
      return;
    }

    const [
      , // full match
      targetBuildDir,
      packageTarget,
      packageName,
    ] = match;

    const packageTargetPath = `${targetBuildDir}:${packageTarget}`;

    return [
      packageName,
      packageTargetPath,
    ];
  }

  private async _getReferencesToManifests(): Promise<boolean> {
    const gitArgs = [
      '--no-pager',
      'grep',
      '--recurse-submodules',
      '-I',
      '--extended-regexp',
      // '--only-matching', // grep BUG! --column value is wrong for second match in line
      // '--column', // not useful without --only-matching
      '--line-number',
      '--no-column',
      '--no-color',
      'fuchsia-pkg://fuchsia.com/([^#]*)#meta/(-|\\w)*\\.cmx?',
    ];

    log.info(
      `Searching for component URLs('fuchsia-pkg://...cm[x]') referenced from any text document ` +
      `in the 'fuchsia.git' repo, by running the command: \n\n` +
      `  \`git ${gitArgs.join(' ')}\`\n\n` +
      `from the '${this._baseUri.path}' directory.`
    );

    let gitGrep = child_process.spawnSync(
      'git',
      gitArgs,
      { cwd: `${this._baseUri.path}` }
    );

    if (gitGrep.error) {
      log.error(
        `Error executing the \`git grep\` command: '${gitGrep.error}'\n`
      );
      return false;
    }

    if (gitGrep.status !== 0) {
      log.error(
        `Error (${gitGrep.status}) executing the \`git grep\` command: '${gitGrep.stderr}'\n`
      );
      return false;
    }

    const text = gitGrep.stdout.toString();

    // patterns end in either '.cm' or '.cmx'
    const urlRegEx = /\bfuchsia-pkg:\/\/fuchsia.com\/([-\w]+)(?:\?[^#]*)?#meta\/([-\w]+).cmx?\b/g;

    let loggedAtLeastOneExample = false;

    let start = 0;
    while (start < text.length) {
      let end = text.indexOf('\n', start);
      if (end === -1) {
        end = text.length;
      }
      const line = text.substr(start, end - start);
      start = end + 1;
      const [path, lineNumberStr] = line.split(':', 2);
      const lineNumber: number = (+lineNumberStr) - 1;
      const matchedLine = line.substr(path.length + 1 + lineNumberStr.length);
      let match;
      while ((match = urlRegEx.exec(matchedLine))) {
        const componentUrl = match[0];
        const packageName = match[1];
        const componentName = match[2];
        const column = match.index - 1;
        const sourceUri = this._baseUri.with({ path: `${this._baseUri.path}/${path}` });
        this.addReference(packageName, componentName, componentUrl, sourceUri, lineNumber, column);
        if (!loggedAtLeastOneExample) {
          loggedAtLeastOneExample = true;
          log.debug([
            `Getting references to manifests. For example, '${componentUrl}' is referenced by `,
            `'${sourceUri.fsPath}:`,
            `${lineNumber + 1}:`,
            `${column + 1}:`,
            `${lineNumber + 1}:`,
            `${column + componentUrl.length + 1}`,
          ].join(''));
        }
      }
      if (!loggedAtLeastOneExample) {
        loggedAtLeastOneExample = true;
        log.warn(
          `RegEx failed to match the first line returned from \`git grep\`.\n\n` +
          `  Line: '${matchedLine}'\n` +
          `  RegEx: ${urlRegEx}`
        );
      }
    }

    if (loggedAtLeastOneExample) {
      log.info('The data required by the ReferenceProvider is loaded.');
    } else {
      log.error(
        `No component URLs ('fuchsia-pkg://...cm[x]') were found in the 'fuchsia.git' repo, by ` +
        `running the command:\n\n` +
        `  \`git ${gitArgs.join(' ')}\`\n\n` +
        `from the '${this._baseUri.path}' directory.`
      );
    }
    return true;
  }

  // TODO(richkadel): find links to fuchsia Service declarations in .fidl files using (I suggest)
  // a `git` command (since we know this works) equivalent of:
  //   $ find ${this._baseUri}/${buildDir} -name '*fidl.json'
  //
  // for each matched file, use VS Code JSON parsing APIs to do the equivalent of:
  //   $ jq '.interface_declarations[] | .name,.location' \
  //     ${this._baseUri}/${buildDir}/fidling/gen/sdk/fidl/fuchsia.logger/fuchsia.logger.fidl.json
  //   "fuchsia.logger/Log"
  //   {
  //       "filename": "../../sdk/fidl/fuchsia.logger/logger.fidl",
  //       "line": 114,
  //       "column": 10,
  //       "length": 3
  //   }
  //   "fuchsia.logger/LogSink"
  //   {
  //       "filename": "../../sdk/fidl/fuchsia.logger/logger.fidl",
  //       "line": 140,
  //       "column": 10,
  //       "length": 7
  //   }
  //
  // And use that information to add additional service links via the provideDocumentLinks()
  // meethod:

  provideDocumentLinks(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): vscode.DocumentLink[] | undefined {
    // patterns end in either '.cm' or '.cmx'
    const regEx = /\bfuchsia-pkg:\/\/fuchsia.com\/([-\w]+)(?:\?[^#]*)?#meta\/([-\w]+).cmx?\b/g;
    const links: vscode.DocumentLink[] = [];
    const text = document.getText();
    let match;
    while ((match = regEx.exec(text))) {
      const packageName = match[1];
      const componentName = match[2];
      const startPos = document.positionAt(match.index);
      const endPos = document.positionAt(match.index + match[0].length);
      const linkRange = new vscode.Range(startPos, endPos);
      const packageAndComponent = `${packageName}/${componentName}`;
      let documentUri = this._packageAndComponentToManifestUri.get(packageAndComponent);
      if (NORMALIZE_WORD_SEPARATORS && !documentUri) {
        documentUri = this._packageAndComponentToManifestUri.get(_normalize(packageAndComponent));
      }
      if (documentUri) {
        links.push(new vscode.DocumentLink(linkRange, documentUri));
      }
    }
    return links;
  }

  provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.ReferenceContext,
    token: vscode.CancellationToken,
  ): vscode.Location[] | undefined {
    const ext = document.uri.path.split('.').slice(-1)[0];
    // For unit testing, the document is virtual, and will be untitled, but we can check its
    // languageId. Otherwise, check its extension. For real manifest files, the language ID may
    // be json or json5.
    if (document.languageId !== 'untitled-fuchsia-manifest' && ext !== 'cml' && ext !== 'cmx') {
      return;
    }
    const packageAndComponent = this._sourcePathToPackageAndComponent.get(document.uri.fsPath);
    if (!packageAndComponent) {
      return;
    }
    let references = this._packageAndComponentToReferences.get(packageAndComponent);
    if (NORMALIZE_WORD_SEPARATORS && !references) {
      references = this._packageAndComponentToReferences.get(_normalize(packageAndComponent));
    }
    return references;
  }

  provideTerminalLinks(
    context: vscode.TerminalLinkContext,
    token: vscode.CancellationToken
  ): vscode.TerminalLink[] | undefined {
    const regEx = /\bfuchsia-pkg:\/\/fuchsia.com\/([-\w]+)(?:\?[^#]*)?#meta\/([-\w]+).cmx?\b/g;
    const links: ComponentUrlTerminalLink[] = [];
    let match;
    while ((match = regEx.exec(context.line))) {
      const startIndex = match.index;
      const [
        link,
        packageName,
        componentName,
      ] = match;
      const packageAndComponent = `${packageName}/${componentName}`;
      let documentUri = this._packageAndComponentToManifestUri.get(packageAndComponent);
      if (NORMALIZE_WORD_SEPARATORS && !documentUri) {
        documentUri = this._packageAndComponentToManifestUri.get(_normalize(packageAndComponent));
      }
      let tooltip;
      if (documentUri) {
        tooltip = 'Open component manifest';
      } else if (SHOW_UNRESOLVED_TERMINAL_LINKS) {
        tooltip = 'Manifest not found!';
      } else {
        continue; // don't add the link
      }
      links.push({
        startIndex,
        length: link.length,
        tooltip,
        documentUri,
      });
    }
    return links;
  }

  handleTerminalLink(link: ComponentUrlTerminalLink) {
    if (link.documentUri) {
      const document = vscode.workspace.openTextDocument(link.documentUri).then(document => {
        vscode.window.showTextDocument(document);
      });
    }
  }

  addLink(packageName: string, componentName: string, manifestUri: vscode.Uri) {
    const packageAndComponent = `${packageName}/${componentName}`;
    this._addLinkToMap(packageAndComponent, manifestUri);
    if (NORMALIZE_WORD_SEPARATORS) {
      const normalizedPackageAndComponent = _normalize(packageAndComponent);
      if (normalizedPackageAndComponent !== packageAndComponent) {
        this._addLinkToMap(normalizedPackageAndComponent, manifestUri);
      }
    }
  }

  private _addLinkToMap(packageAndComponent: string, manifestUri: vscode.Uri) {
    this._packageAndComponentToManifestUri.set(packageAndComponent, manifestUri);
    this._sourcePathToPackageAndComponent.set(manifestUri.fsPath, packageAndComponent);
  }

  addReference(
    packageName: string,
    componentName: string,
    componentUrl: string,
    referencedByUri: vscode.Uri,
    lineNumber: number,
    column: number,
  ) {
    const packageAndComponent = `${packageName}/${componentName}`;
    const range = new vscode.Range(
      lineNumber,
      column,
      lineNumber,
      column + componentUrl.length,
    );
    this._addReferenceToMap(packageAndComponent, referencedByUri, range);
    if (NORMALIZE_WORD_SEPARATORS) {
      const normalizedPackageAndComponent = _normalize(packageAndComponent);
      if (normalizedPackageAndComponent !== packageAndComponent) {
        this._addReferenceToMap(normalizedPackageAndComponent, referencedByUri, range);
      }
    }
  }

  private _addReferenceToMap(packageAndComponent: string, referencedByUri: vscode.Uri, range: vscode.Range) {
    let references = this._packageAndComponentToReferences.get(packageAndComponent);
    if (!references) {
      references = [];
      this._packageAndComponentToReferences.set(packageAndComponent, references);
    }
    references.push(new vscode.Location(referencedByUri, range));
  }
}

function _normalize(nameOrTarget: string): string {
  return nameOrTarget.replace(/-/g, '_');
}