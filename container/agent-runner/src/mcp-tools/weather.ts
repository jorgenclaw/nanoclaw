/**
 * MCP tool: weather lookup via wttr.in.
 *
 * Smaller local models (gemma4:31b, llama4:scout) struggle with the
 * agent-browser two-step pattern (open → snapshot) and doom-loop on weather
 * queries. This wraps `curl wttr.in/<city>?format=j1` in a single tool call
 * that returns a compact JSON payload — no browser navigation needed.
 *
 * wttr.in is free and rate-limit-friendly. No API key. No data leaves to a
 * third-party tracker beyond wttr.in itself.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

import { registerTools } from './server.js';

const execFileAsync = promisify(execFile);

interface WttrCurrent {
  temp_F?: string;
  temp_C?: string;
  weatherDesc?: Array<{ value?: string }>;
  humidity?: string;
  windspeedMiles?: string;
  winddir16Point?: string;
  FeelsLikeF?: string;
}

interface WttrDay {
  date?: string;
  maxtempF?: string;
  mintempF?: string;
  hourly?: Array<{ weatherDesc?: Array<{ value?: string }>; chanceofrain?: string }>;
}

registerTools([
  {
    tool: {
      name: 'weather',
      description:
        'Get current weather and 3-day forecast for a city. Single-call alternative to agent-browser. ' +
        'Returns current conditions (temp, description, humidity, wind, feels-like) and a 3-day outlook ' +
        '(date, high/low °F, midday conditions, chance of rain). Use this for any weather question — ' +
        'do NOT use agent-browser to scrape weather.com or google.com.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          city: {
            type: 'string',
            description:
              'City and (optional) region/country. Examples: "Manteca CA", "Mammoth Lakes CA", ' +
              '"Tokyo", "Mexico City". Spaces become +.',
          },
        },
        required: ['city'],
      },
    },
    async handler(args) {
      const { city } = args as { city: string };
      const target = city.trim().replace(/\s+/g, '+');
      const url = `https://wttr.in/${encodeURIComponent(target)}?format=j1`;
      try {
        const { stdout } = await execFileAsync('curl', ['-fsSL', '--max-time', '15', url], {
          maxBuffer: 4 * 1024 * 1024,
        });
        const data = JSON.parse(stdout) as {
          current_condition?: WttrCurrent[];
          weather?: WttrDay[];
          nearest_area?: Array<{ areaName?: Array<{ value?: string }> }>;
        };
        const cur = data.current_condition?.[0];
        const area = data.nearest_area?.[0]?.areaName?.[0]?.value ?? city;
        const days =
          data.weather?.slice(0, 3).map((d) => ({
            date: d.date,
            highF: d.maxtempF ? Number(d.maxtempF) : null,
            lowF: d.mintempF ? Number(d.mintempF) : null,
            midday: d.hourly?.[4]?.weatherDesc?.[0]?.value ?? null,
            chanceOfRain: d.hourly?.[4]?.chanceofrain ? Number(d.hourly[4].chanceofrain) : null,
          })) ?? [];
        const summary = {
          location: area,
          current: cur
            ? {
                tempF: cur.temp_F ? Number(cur.temp_F) : null,
                feelsLikeF: cur.FeelsLikeF ? Number(cur.FeelsLikeF) : null,
                description: cur.weatherDesc?.[0]?.value ?? null,
                humidityPct: cur.humidity ? Number(cur.humidity) : null,
                windMph: cur.windspeedMiles ? Number(cur.windspeedMiles) : null,
                windDir: cur.winddir16Point ?? null,
              }
            : null,
          forecast: days,
          source: 'wttr.in',
        };
        return { content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }] };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Weather lookup failed for "${city}": ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  },
]);
