import { NextResponse } from 'next/server';

// Mints a short-lived token for AssemblyAI Universal-Streaming v3.
// Docs: https://www.assemblyai.com/docs/speech-to-text/universal-streaming
export async function GET() {
  try {
    const assemblyAiKey = process.env.ASSEMBLYAI_API_KEY;
    if (!assemblyAiKey) {
      return NextResponse.json({ error: 'ASSEMBLYAI_API_KEY is not set' }, { status: 400 });
    }

    const response = await fetch(
      'https://streaming.assemblyai.com/v3/token?expires_in_seconds=600',
      {
        method: 'GET',
        headers: { Authorization: assemblyAiKey },
      }
    );

    if (!response.ok) {
      const body = await response.text();
      console.error('AssemblyAI token request failed:', response.status, body);
      return NextResponse.json(
        { error: `Token request failed (${response.status})` },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json({ token: data.token });
  } catch (error) {
    console.error('AssemblyAI Token Error:', error);
    return NextResponse.json({ error: 'Failed to generate token' }, { status: 500 });
  }
}
