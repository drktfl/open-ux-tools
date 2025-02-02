import { join, dirname, sep } from 'path';
import { create as createStorage } from 'mem-fs';
import type { Editor } from 'mem-fs-editor';
import { create } from 'mem-fs-editor';
import { updateManifest, updatePackageJson, updateCdsFilesWithAnnotations, writeAnnotationXmlFiles } from './updates';
import type { CustomMiddleware, FioriToolsProxyConfigBackend as ProxyBackend } from '@sap-ux/ui5-config';
import { UI5Config, yamlErrorCode, YAMLError } from '@sap-ux/ui5-config';
import prettifyXml from 'prettify-xml';
import { enhanceData, getAnnotationNamespaces } from './data';
import { t } from './i18n';
import type { EdmxOdataService, ProjectPaths } from './types';
import {
    OdataService,
    OdataVersion,
    ServiceType,
    CdsAnnotationsInfo,
    EdmxAnnotationsInfo,
    NamespaceAlias
} from './types';
import { getWebappPath } from '@sap-ux/project-access';
import { generateMockserverConfig } from '@sap-ux/mockserver-config-writer';
import { deleteServiceFromManifest, removeAnnotationsFromCDSFiles, removeAnnotationXmlFiles } from './delete';

/**
 * Ensures the existence of the given files in the provided base path. If a file in the provided list does not exit, an error would be thrown.
 *
 * @param basePath - the root path of an existing UI5 application
 * @param files - list of files that need to exist
 * @param fs - the memfs editor instance
 */
function ensureExists(basePath: string, files: string[], fs: Editor): void {
    files.forEach((path) => {
        if (!fs.exists(join(basePath, path))) {
            throw new Error(t('error.requiredProjectFileNotFound', { path }));
        }
    });
}

/**
 * Try finding a package.json and a ui5.yaml for the given project by looking upwards in the folder hierachy.
 *
 * @param {string} basePath - the root path of an existing UI5 application
 * @param {Editor} [fs] - the memfs editor instance
 * @returns an object with the optional locations of the package.json and ui5.yaml, ui5-local.yaml, ui5-mock.yaml
 */
export async function findProjectFiles(basePath: string, fs: Editor): Promise<ProjectPaths> {
    const files: ProjectPaths = {};
    const parts = basePath.split(sep);

    while (parts.length > 0 && (!files.packageJson || !files.ui5Yaml || !files.ui5LocalYaml || !files.ui5MockYaml)) {
        const path = parts.join(sep);
        if (!files.packageJson && fs.exists(join(path, 'package.json'))) {
            files.packageJson = join(path, 'package.json');
        }
        if (!files.ui5Yaml && fs.exists(join(path, 'ui5.yaml'))) {
            files.ui5Yaml = join(path, 'ui5.yaml');
        }
        if (!files.ui5LocalYaml && fs.exists(join(path, 'ui5-local.yaml'))) {
            files.ui5LocalYaml = join(path, 'ui5-local.yaml');
        }
        if (!files.ui5MockYaml && fs.exists(join(path, 'ui5-mock.yaml'))) {
            files.ui5MockYaml = join(path, 'ui5-mock.yaml');
        }
        parts.pop();
    }

    return files;
}

/**
 * Generates mockserver middleware config for ui5-local.yaml file based on ui5-mock.yaml.
 *
 * @param {Editor} fs - the memfs editor instance
 * @param {OdataService} ui5YamlPath - path pointing to the ui5.yaml file
 * @param {UI5Config} ui5LocalConfigPath - ui5-local.yaml configuration
 * @param {string} ui5LocalConfig - path pointing to the ui5-local.yaml file
 * @returns {Promise<Editor>} the updated memfs editor instance
 */
async function generateMockserverMiddlewareBasedOnUi5MockYaml(
    fs: Editor,
    ui5YamlPath: string,
    ui5LocalConfigPath?: string,
    ui5LocalConfig?: UI5Config
): Promise<void> {
    // Update ui5-local.yaml with mockserver middleware from ui5-mock.yaml
    const ui5MockYamlPath = join(dirname(ui5YamlPath), 'ui5-mock.yaml');
    const ui5MockYamlConfig = await UI5Config.newInstance(fs.read(ui5MockYamlPath));
    const mockserverMiddlewareFromUi5Mock = ui5MockYamlConfig.findCustomMiddleware(
        'sap-fe-mockserver'
    ) as CustomMiddleware;
    if (ui5LocalConfigPath && fs.exists(ui5LocalConfigPath) && ui5LocalConfig && mockserverMiddlewareFromUi5Mock) {
        ui5LocalConfig.updateCustomMiddleware(mockserverMiddlewareFromUi5Mock);
    }
}

/**
 * Extends backend middleware for UI5Config with service data.
 *
 * @param {Editor} fs - the memfs editor instance
 * @param {OdataService} service - the OData service instance data
 * @param {UI5Config} ui5Config - UI5 configuration
 * @param {string} ui5ConfigPath - path to the YAML config file
 * @throws {Error} - if required UI5 project files are not found
 */
function extendBackendMiddleware(fs: Editor, service: OdataService, ui5Config: UI5Config, ui5ConfigPath: string): void {
    try {
        ui5Config.addBackendToFioriToolsProxydMiddleware(service.previewSettings as ProxyBackend);
    } catch (error: any) {
        if (
            (error instanceof YAMLError && error.code === yamlErrorCode.nodeNotFound) ||
            error.message === 'Could not find fiori-tools-proxy'
        ) {
            ui5Config.addFioriToolsProxydMiddleware({
                backend: [service.previewSettings as ProxyBackend],
                ignoreCertError: service.ignoreCertError
            });
        } else {
            throw error;
        }
    }
    fs.write(ui5ConfigPath, ui5Config.toString());
}

/**
 * Returns all paths of the EDMX service annotations.
 *
 * @param {OdataService} edmxAnnotations - EDMX OData service annotations.
 * @returns {string} annotation paths.
 */
function getEDMXAnnotationPaths(edmxAnnotations: EdmxAnnotationsInfo | EdmxAnnotationsInfo[]): string[] {
    const emdxAnnotationsPaths: string[] = [];
    if (Array.isArray(edmxAnnotations)) {
        edmxAnnotations.forEach((annotation: EdmxAnnotationsInfo) => {
            const technicalName = encodeURIComponent(annotation.technicalName);
            emdxAnnotationsPaths.push(
                `/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/Annotations(TechnicalName='${technicalName}',Version='0001')/$value/` // This is how annotation paths are stored in manifest for ODataAnnotations
            );
        });
    } else {
        const technicalName = encodeURIComponent(edmxAnnotations.technicalName);
        emdxAnnotationsPaths.push(
            `/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/Annotations(TechnicalName='${technicalName}',Version='0001')/$value/`
        );
    }
    return emdxAnnotationsPaths;
}

/**
 * Writes local copies of metadata and annotations.
 *
 * @param {Editor} fs - the memfs editor instance
 * @param {string} basePath - the root path of an existing UI5 application
 * @param {string} webappPath - the webapp path of an existing UI5 application
 * @param {string} templateRoot - path to the file templates
 * @param {OdataService} service - the OData service instance with EDMX type
 */
async function writeLocalServiceFiles(
    fs: Editor,
    basePath: string,
    webappPath: string,
    templateRoot: string,
    service: EdmxOdataService
): Promise<void> {
    // mainService should be used in case there is no name defined for service
    fs.write(
        join(webappPath, 'localService', service.name ?? 'mainService', 'metadata.xml'),
        prettifyXml(service.metadata, { indent: 4 })
    );
    // Adds local annotations to datasources section of manifest.json and writes the annotations file
    if (service.localAnnotationsName) {
        const namespaces = getAnnotationNamespaces(service);
        fs.copyTpl(
            join(templateRoot, 'add', 'annotation.xml'),
            join(basePath, 'webapp', 'annotations', `${service.localAnnotationsName}.xml`),
            { ...service, namespaces }
        );
    }
}

/**
 * Writes EDMX service data to ui5.yaml, ui5-mock.yaml, ui5-local.yaml, package.json and annotations xml files.
 *
 * @param {Editor} fs - the memfs editor instance
 * @param {string} basePath - the root path of an existing UI5 application
 * @param {ProjectPaths} paths - locations of the package.json and ui5.yaml, ui5-local.yaml, ui5-mock.yaml
 * @param {string} templateRoot - path to the file templates
 * @param {OdataService} service - the OData service instance with EDMX type
 */
async function writeEDMXServiceFiles(
    fs: Editor,
    basePath: string,
    paths: ProjectPaths,
    templateRoot: string,
    service: EdmxOdataService
): Promise<void> {
    let ui5Config: UI5Config | undefined;
    let ui5LocalConfig: UI5Config | undefined;
    let ui5MockConfig: UI5Config | undefined;
    if (paths.ui5Yaml) {
        ui5Config = await UI5Config.newInstance(fs.read(paths.ui5Yaml));
        // Update ui5.yaml with backend middleware
        extendBackendMiddleware(fs, service, ui5Config, paths.ui5Yaml);
        // Update ui5-local.yaml with backend middleware
        if (paths.ui5LocalYaml) {
            ui5LocalConfig = await UI5Config.newInstance(fs.read(paths.ui5LocalYaml));
            extendBackendMiddleware(fs, service, ui5LocalConfig, paths.ui5LocalYaml);
        }
    }
    if (service.metadata) {
        const webappPath = await getWebappPath(basePath, fs);
        if (paths.ui5Yaml && ui5Config) {
            const config = {
                webappPath: webappPath
            };
            // Generate mockserver middleware for ui5-mock.yaml
            await generateMockserverConfig(basePath, config, fs);
            // Update ui5-local.yaml with mockserver middleware from newly created/updated ui5-mock.yaml
            await generateMockserverMiddlewareBasedOnUi5MockYaml(fs, paths.ui5Yaml, paths.ui5LocalYaml, ui5LocalConfig);
            // Update ui5-mock.yaml with backend middleware
            if (paths.ui5MockYaml) {
                ui5MockConfig = await UI5Config.newInstance(fs.read(paths.ui5MockYaml));
                extendBackendMiddleware(fs, service, ui5MockConfig, paths.ui5MockYaml);
            }
        }
        await writeLocalServiceFiles(fs, basePath, webappPath, templateRoot, service);
    }
    if (paths.packageJson && paths.ui5Yaml) {
        updatePackageJson(paths.packageJson, fs, !!service.metadata);
    }
    if (paths.ui5LocalYaml && ui5LocalConfig) {
        // write ui5 local yaml if service type is not CDS
        fs.write(paths.ui5LocalYaml, ui5LocalConfig.toString());
    }
    writeAnnotationXmlFiles(fs, basePath, service.name ?? 'mainService', service.annotations);
}

/**
 * Writes the odata service related file updates to an existing UI5 project specified by the base path.
 *
 * @param {string} basePath - the root path of an existing UI5 application
 * @param {OdataService} service - the OData service instance
 * @param {Editor} [fs] - the memfs editor instance
 * @throws {Error} - if required UI5 project files are not found
 * @returns {Promise<Editor>} the updated memfs editor instance
 */
async function generate(basePath: string, service: OdataService, fs?: Editor): Promise<Editor> {
    if (!fs) {
        fs = create(createStorage());
    }
    const paths = await findProjectFiles(basePath, fs);
    ensureExists(basePath, ['webapp/manifest.json'], fs);
    await enhanceData(basePath, service, fs);
    // Set isServiceTypeEdmx true if service is EDMX
    const isServiceTypeEdmx = service.type === ServiceType.EDMX;
    // Prepare template folder for manifest and xml updates
    const templateRoot = join(__dirname, '../templates');
    // Update manifest.json
    await updateManifest(basePath, service, fs);
    // Dont extend backend and mockserver middlewares if service type is CDS
    if (isServiceTypeEdmx) {
        await writeEDMXServiceFiles(fs, basePath, paths, templateRoot, service as EdmxOdataService);
    } else if (!isServiceTypeEdmx && service.annotations) {
        // Update cds files with annotations only if service type is CDS and annotations are provided
        await updateCdsFilesWithAnnotations(service.annotations as CdsAnnotationsInfo | CdsAnnotationsInfo[], fs);
    }
    return fs;
}

/**
 * Removes service related data from project files for an existing UI5 project specified by the base path.
 * Works as follow:
 * 1. Service is removed from manifest.
 * If service type is EDMX:
 * 2. ui5.yaml
 *  - backend data of the service is removed from fiori-tools-proxy middleware
 * 3. ui5-local.yaml
 *  - backend data of the service is removed from fiori-tools-proxy middleware
 *  - service is removed from mockserver middleware
 * 4. ui5-mock.yaml
 *  - service is removed from mockserver middleware
 * If service type is CDS:
 * 2. annotations of the service are removed from CDS files.
 *
 * @param {string} basePath - the root path of an existing UI5 application
 * @param {OdataService} service - the OData service instance
 * @param {string} service.name - name of the OData service instance
 * @param {string} service.path - path of the OData service instance
 * @param {string} service.url - url of the OData service instance
 * @param {ServiceType} service.type - type of the OData service instance
 * @param {OdataService['annotations']} service.annotations - services annotations (EDMX or CDS)
 * @param {Editor} [fs] - the memfs editor instance
 * @throws {Error} - if required UI5 project files are not found
 * @returns {Promise<Editor>} the updated memfs editor instance
 */
async function remove(
    basePath: string,
    service: Required<Pick<OdataService, 'name' | 'path' | 'url' | 'type' | 'annotations'>>,
    fs?: Editor
): Promise<Editor> {
    if (!fs) {
        fs = create(createStorage());
    }
    let ui5Config: UI5Config | undefined;
    let ui5LocalConfig: UI5Config | undefined;
    let ui5MockConfig: UI5Config | undefined;
    const paths = await findProjectFiles(basePath, fs);
    // Delete service and it's annotations from manifest
    deleteServiceFromManifest(basePath, service.name, fs);
    const isServiceTypeEdmx = service.type === ServiceType.EDMX;
    // Remove service related data from middlewares for EDMX services
    if (isServiceTypeEdmx) {
        // Delete service data from manifest.json
        if (paths.ui5Yaml) {
            ui5Config = await UI5Config.newInstance(fs.read(paths.ui5Yaml));
            // Delete service backend from fiori-tools-proxy middleware config
            ui5Config.removeBackendFromFioriToolsProxydMiddleware(service.url);
            fs.write(paths.ui5Yaml, ui5Config.toString());
        }
        const serviceAnnotationPaths = getEDMXAnnotationPaths(
            service.annotations as EdmxAnnotationsInfo | EdmxAnnotationsInfo[]
        );
        if (paths.ui5LocalYaml) {
            ui5LocalConfig = await UI5Config.newInstance(fs.read(paths.ui5LocalYaml));
            // Delete service backend from fiori-tools-proxy middleware config
            ui5LocalConfig.removeBackendFromFioriToolsProxydMiddleware(service.url);
            // Delete service from mockserver middleware config
            ui5LocalConfig.removeServiceFromMockServerMiddleware(service.path, serviceAnnotationPaths);
            fs.write(paths.ui5LocalYaml, ui5LocalConfig.toString());
        }
        if (paths.ui5MockYaml) {
            ui5MockConfig = await UI5Config.newInstance(fs.read(paths.ui5MockYaml));
            // Delete service backend from fiori-tools-proxy middleware config
            ui5MockConfig.removeBackendFromFioriToolsProxydMiddleware(service.url);
            // Delete service from mockserver config
            ui5MockConfig.removeServiceFromMockServerMiddleware(service.path, serviceAnnotationPaths);
            fs.write(paths.ui5MockYaml, ui5MockConfig.toString());
        }
        removeAnnotationXmlFiles(
            fs,
            basePath,
            service.name ?? 'mainService',
            service.annotations as EdmxAnnotationsInfo | EdmxAnnotationsInfo[]
        );
    } else {
        // Remove annotations from CDS files based on annotations info
        await removeAnnotationsFromCDSFiles(service.annotations as CdsAnnotationsInfo | CdsAnnotationsInfo[], fs);
    }
    return fs;
}

export { generate, remove, OdataVersion, OdataService, ServiceType, EdmxAnnotationsInfo, CdsAnnotationsInfo };
export { getAnnotationNamespaces, NamespaceAlias };
