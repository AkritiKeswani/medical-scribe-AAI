import { GoogleGenAI } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function POST(req: NextRequest) {
  try {
    const { transcript } = await req.json();

    if (!transcript || typeof transcript !== "string" || !transcript.trim()) {
      return NextResponse.json({ error: "Empty transcript" }, { status: 400 });
    }

    const prompt = `You are a clinical documentation assistant.

Generate a complete SOAP note from the full patient encounter transcript below.

Rules:
- Only use information explicitly stated in the transcript. Do not hallucinate diagnoses, medications, vitals, or patient details.
- Consolidate duplicate or repeated mentions into a single entry.
- Group related findings where natural.
- If something is uncertain or contradicted later in the transcript, prefer the most recent statement.
- Return valid JSON only.

Sections (each is an array of strings):
- subjective
- objective
- assessment
- plan
- open_questions

Full Transcript:
"""
${transcript}
"""

Return ONLY a valid JSON object matching the requested structure.`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: { responseMimeType: "application/json" },
    });

    const text = response.text;
    if (!text) throw new Error("No response text");
    const json = JSON.parse(text);
    return NextResponse.json(json);
  } catch (error) {
    console.error("SOAP finalize error:", error);
    return NextResponse.json({ error: "Failed to finalize SOAP note" }, { status: 500 });
  }
}
