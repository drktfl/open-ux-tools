const { initUi5MappingStrategy } = require('../../src/utils/ui5MappingStrategy');
const path = require('path');

describe('Ui5 Mapping Strategy', () => {
    it('should map the files from the project to the file system', async () => {
        const { pathMappingFn, ui5VersionInfo } = await initUi5MappingStrategy({
            configPath: 'test/fixtures/ui5.yaml'
        });

        expect(pathMappingFn).not.toBe(null);
        ui5VersionInfo.libraries[0].version = '0.0.0'; // needed other this fail on bump :)
        expect(ui5VersionInfo).toMatchSnapshot();
        expect(path.relative(__dirname, pathMappingFn('sap/ui/demo/todo/Component'))).toBe(
            path.relative(__dirname, path.resolve(__dirname, '../fixtures/webapp/Component.js'))
        );
        expect(pathMappingFn('sap/ui/core/Component').split('@openui5')[1]).toBe(
            path.resolve('/sap.ui.core/1.130.0/src/sap/ui/core/Component.js')
        );

        const secondpathMapping = await initUi5MappingStrategy({ configPath: 'test/fixtures/ui5.yaml' });
        expect(secondpathMapping).toStrictEqual(pathMappingFn); // No need to recreate the pathMappingFn
    }, 30000);
});
