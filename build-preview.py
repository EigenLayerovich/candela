"""Bundle Candela into one self-contained HTML file (used for the hosted preview)."""
import re, pathlib, sys
root = pathlib.Path(__file__).parent
html = (root / 'index.html').read_text()
css = (root / 'css/style.css').read_text()
body = re.search(r'<body>(.*?)</body>', html, re.S).group(1)
body = re.sub(r'\s*<script src="[^"]+"></script>', '', body)
scripts = ''.join(f'<script>\n{(root / "js" / n).read_text()}\n</script>\n' for n in ['indicators.js', 'data.js', 'chart.js', 'script.js', 'alerts-core.js', 'app.js'])
out = f"""<title>Candela Charts</title>
<style>
{css}
html, body {{ height: 100%; }}
</style>
{body}
<script>window.CANDELA_PREVIEW = true;</script>
{scripts}"""
dest = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'candela-preview.html'
dest.write_text(out)
print(dest, len(out), 'bytes')
