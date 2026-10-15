"""Build a universal VSIX from an explicit file allowlist, without downloads."""
import json
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from xml.sax.saxutils import escape

root = Path(__file__).resolve().parent
manifest = json.loads((root / 'package.json').read_text())
name, version, publisher = (escape(manifest[key]) for key in ('name', 'version', 'publisher'))
vsix = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
<Metadata><Identity Id="{name}" Version="{version}" Publisher="{publisher}" Language="en-US" />
<DisplayName>CallScout</DisplayName>
<Description xml:space="preserve">Discover direct C++ call paths and preview source definitions.</Description>
<Categories>Other,Visualization</Categories>
<Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.85.0" /></Properties>
<License>extension/LICENSE</License></Metadata>
<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation><Dependencies />
<Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" />
<Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" />
<Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" /></Assets>
</PackageManifest>'''
content_types = '''<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="json" ContentType="application/json" />
<Default Extension="js" ContentType="application/javascript" />
<Default Extension="md" ContentType="text/markdown" />
<Default Extension="svg" ContentType="image/svg+xml" />
<Default Extension="vsixmanifest" ContentType="text/xml" />
<Override PartName="/extension/LICENSE" ContentType="text/plain" />
</Types>'''
output = root / f'{name}-{version}.vsix'
with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
    archive.writestr('extension.vsixmanifest', vsix)
    archive.writestr('[Content_Types].xml', content_types)
    for file in ['package.json', *manifest['files']]:
        source = root / file
        source.resolve().relative_to(root)
        archive.write(source, 'extension/' + file)

print(output)
