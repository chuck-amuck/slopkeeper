#!/bin/sh
# Builds the web UI's charting and calendar libraries into web/public, with only the parts it uses, and copies their
# licences. Run from the repo root when changing a version (no npm here, so it runs in node:24):
#   docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_cache=/tmp/npm -v "$PWD":/app -w /app node:24 sh scripts/build-vendor.sh
set -eu
ECHARTS=6.1.0
CALLY=0.9.2
ESBUILD=0.25.12
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
npm init -y >/dev/null
npm install --silent --no-audit --no-fund "echarts@$ECHARTS" "cally@$CALLY" "esbuild@$ESBUILD"
cat > charts.js <<'JS'
import * as echarts from 'echarts/core';
import { BarChart, HeatmapChart, LineChart } from 'echarts/charts';
// No legend or zoom: web/public/charts.js has its own legend buttons, and dragging across a chart picks a range
import { AriaComponent, CalendarComponent, GridComponent, MarkAreaComponent, MarkLineComponent, TooltipComponent, VisualMapComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
echarts.use([LineChart, BarChart, HeatmapChart, GridComponent, TooltipComponent, MarkLineComponent, MarkAreaComponent, VisualMapComponent, CalendarComponent, AriaComponent, SVGRenderer]);
export const { init, getInstanceByDom } = echarts;
JS
echo "import 'cally';" > calendar.js
banner() { printf '/*! %s, built by scripts/build-vendor.sh. Licence in web/vendor-licences */' "$1"; }
npx esbuild charts.js --bundle --format=esm --minify --target=es2022 --legal-comments=none --banner:js="$(banner "Apache ECharts $ECHARTS (Apache-2.0)")" --outfile=/app/web/public/vendor-echarts.js
npx esbuild calendar.js --bundle --format=esm --minify --target=es2022 --legal-comments=none --banner:js="$(banner "Cally $CALLY (MIT)")" --outfile=/app/web/public/vendor-cally.js
mkdir -p /app/web/vendor-licences
cp node_modules/echarts/LICENSE /app/web/vendor-licences/echarts-LICENSE
cp node_modules/echarts/NOTICE /app/web/vendor-licences/echarts-NOTICE
cp node_modules/cally/LICENSE /app/web/vendor-licences/cally-LICENSE 2>/dev/null || cp node_modules/cally/LICENSE.md /app/web/vendor-licences/cally-LICENSE
