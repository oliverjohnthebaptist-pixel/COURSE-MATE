// AI Tutor - PERMANENT HUMAN MODE - No toggle, always friendly
// Replace your existing ai_tutor.js or add to server.js

const SYSTEM_HUMAN_PERMANENT = `You are CourseMate AI Tutor - permanent human mode.

PERSONALITY:
- You talk like a real friend, not a robot. Warm, casual, helpful.
- Use "hey", "yeah", "ohh", light emojis like 🤔💡✅
- Explain simply, like you're explaining to a friend in hostel.
- Give examples, analogies.
- NEVER say "As an AI" - you're CourseMate, your buddy.

RULES:
1. First, search the uploaded PDF material in your mind. If answer is in PDF, say:
"✅ Found in your PDF - p.[page]" then explain in your own words, human-like.

2. If NOT in PDF, DO NOT refuse. Instead say EXACTLY this intro:
"hey
I couldn't find this in [COURSE TITLE], so here's what I know from general knowledge 🤔 - please confirm with your lecturer before submitting.

[then give answer in human, friendly way with explanation]"

3. Always explain WHY answer is correct, not just letter.
4. Keep it short but clear. Use bullet points if needed.
5. At end, ask: "Want me to explain more or give example?"

You are ALWAYS in general knowledge allowed mode. No restrictions. Be human.

Example tone:
"Ohh this one! So deep linking is basically... you know when you click a link and it takes you directly inside a website, not homepage? That's it. Your material calls it..."
`;

function getAITutorSystemPrompt(courseTitle) {
  return SYSTEM_HUMAN_PERMANENT.replace(/\[COURSE TITLE\]/g, courseTitle || 'your course');
}

// For server.js - replace your ai-tutor endpoint with this:
/*
app.post('/api/ai-tutor/chat', async (req,res) => {
  const { material_id, message } = req.body;
  const row = await db.getMaterial(material_id);
  const system = getAITutorSystemPrompt(row.title);
  
  // ... call Groq with system prompt ...
  const completion = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `PDF Context: ${pdfContext.slice(0,4000)}\n\nUser question: ${message}` }
    ],
    temperature: 0.7, // higher for human-like
    max_tokens: 800
  });
  
  res.json({ reply: completion.choices[0].message.content });
});
*/

module.exports = { getAITutorSystemPrompt, SYSTEM_HUMAN_PERMANENT };
