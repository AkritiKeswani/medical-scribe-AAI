import { GoogleGenAI } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function POST(req: NextRequest) {
  try {
    const { currentState, newChunk } = await req.json();

    const prompt = `You are a clinical documentation assistant.

Given the existing SOAP note and the newest transcript chunk, incrementally update the SOAP note.

Only use explicitly stated information.
Do not hallucinate diagnoses or medications.
Do not invent patient details.
Return valid JSON only.

Maintain these sections:
- subjective (array of strings)
- objective (array of strings)
- assessment (array of strings)
- plan (array of strings)
- open_questions (array of strings)

Existing SOAP Note:
${JSON.stringify(currentState, null, 2)}

New Transcript Chunk:
"${newChunk}"

Update the SOAP note. Return ONLY a valid JSON object matching the requested structure.`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
      }
    });

    const text = response.text;
    if (!text) throw new Error("No response text");
    const json = JSON.parse(text);
    return NextResponse.json(json);
  } catch (error) {
    console.error("SOAP update error:", error);
    return NextResponse.json({ error: "Failed to update SOAP note" }, { status: 500 });
  }
}
