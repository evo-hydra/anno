import { spawn } from 'child_process';

export interface TrafilaturaResult {
  title: string | null;
  text: string | null;
  author: string | null;
  date: string | null;
  language: string | null;
}

function runPythonExtractor(html: string): Promise<TrafilaturaResult | null> {
  return new Promise((resolve) => {
    const proc = spawn('python3', ['scripts/extract_trafilatura.py'], {
      stdio: ['pipe', 'pipe', 'inherit']
    });

    let output = '';
    proc.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });

    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      try {
        const parsed = JSON.parse(output) as TrafilaturaResult;
        resolve(parsed);
      } catch {
        resolve(null);
      }
    });

    proc.stdin.write(html);
    proc.stdin.end();
  });
}

export async function trafilaturaExtract(html: string, _url: string): Promise<{
  title: string;
  content: string;
  author?: string | null;
  publishDate?: string | null;
} | null> {
  const result = await runPythonExtractor(html);
  if (!result || !result.text) return null;

  return {
    title: result.title ?? 'Untitled',
    content: result.text,
    author: result.author,
    publishDate: result.date
  };
}





