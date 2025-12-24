const crypto = require("crypto");

/**
 * OpenAITransformer - OpenAI 格式与其他格式的互转
 */

// ==================== OpenAI -> Claude Request ====================

function transformOpenAIToClaudeRequest(openaiReq) {
  const claudeReq = {
    model: openaiReq.model,
    messages: [],
    stream: openaiReq.stream || false,
  };

  if (openaiReq.max_tokens) claudeReq.max_tokens = openaiReq.max_tokens;
  if (openaiReq.temperature !== undefined) claudeReq.temperature = openaiReq.temperature;
  if (openaiReq.top_p !== undefined) claudeReq.top_p = openaiReq.top_p;
  if (openaiReq.top_k !== undefined) claudeReq.top_k = openaiReq.top_k; // 非标准但常见

  // 提取 system message
  const messages = Array.isArray(openaiReq.messages) ? openaiReq.messages : [];
  const systemMessages = messages.filter((m) => m.role === "system");
  if (systemMessages.length > 0) {
    claudeReq.system = systemMessages.map((m) => m.content).join("\n");
  }

  // 转换 messages
  for (const msg of messages) {
    if (msg.role === "system") continue;

    const claudeMsg = {
      role: msg.role === "assistant" ? "assistant" : "user",
      content: msg.content,
    };

    // 处理多模态 (OpenAI content 数组)
    if (Array.isArray(msg.content)) {
      claudeMsg.content = msg.content.map((item) => {
        if (item.type === "text") {
          return { type: "text", text: item.text };
        }
        if (item.type === "image_url") {
          // OpenAI: image_url.url (base64 or http)
          // Claude: { type: "image", source: { type: "base64", media_type, data } }
          // 简单处理 base64
          const url = item.image_url.url;
          if (url.startsWith("data:")) {
            const [mimeRaw, data] = url.split(",");
            const media_type = mimeRaw.match(/:(.*?);/)[1];
            return {
              type: "image",
              source: {
                type: "base64",
                media_type,
                data,
              },
            };
          }
          // Claude 不直接支持 URL，需自行下载转 base64，此处暂略，假设 client 传 base64
          return { type: "text", text: "[Image URL not supported directly]" };
        }
        return item;
      });
    }

    claudeReq.messages.push(claudeMsg);
  }

  // Tools 转换 (OpenAI -> Claude)
  if (openaiReq.tools && openaiReq.tools.length > 0) {
    claudeReq.tools = openaiReq.tools.map((t) => {
      if (t.type === "function") {
        return {
          name: t.function.name,
          description: t.function.description,
          input_schema: t.function.parameters,
        };
      }
      return null;
    }).filter(Boolean);
  }

  if (openaiReq.tool_choice) {
    if (typeof openaiReq.tool_choice === "string") {
        if (openaiReq.tool_choice === "auto") claudeReq.tool_choice = { type: "auto" };
        else if (openaiReq.tool_choice === "none") claudeReq.tool_choice = { type: "any" }; // Approximate
        else if (openaiReq.tool_choice === "required") claudeReq.tool_choice = { type: "any" };
    } else if (openaiReq.tool_choice.type === "function") {
        claudeReq.tool_choice = { type: "tool", name: openaiReq.tool_choice.function.name };
    }
  }

  return claudeReq;
}

// ==================== OpenAI -> Gemini Request ====================

function transformOpenAIToGeminiRequest(openaiReq) {
    // 基础结构
    const geminiReq = {
        contents: [],
        generationConfig: {},
        tools: [] // Gemini 格式
    };

    if (openaiReq.temperature !== undefined) geminiReq.generationConfig.temperature = openaiReq.temperature;
    if (openaiReq.top_p !== undefined) geminiReq.generationConfig.topP = openaiReq.top_p;
    if (openaiReq.max_tokens) geminiReq.generationConfig.maxOutputTokens = openaiReq.max_tokens;

    // Messages
    let systemInstruction = null;
    for (const msg of openaiReq.messages) {
        if (msg.role === "system") {
            if (!systemInstruction) systemInstruction = { parts: [] };
            systemInstruction.parts.push({ text: msg.content });
        } else {
            const role = msg.role === "assistant" ? "model" : "user";
            const parts = [];
            if (typeof msg.content === "string") {
                parts.push({ text: msg.content });
            } else if (Array.isArray(msg.content)) {
                for (const part of msg.content) {
                    if (part.type === "text") parts.push({ text: part.text });
                    else if (part.type === "image_url") {
                         const url = part.image_url.url;
                         if (url.startsWith("data:")) {
                             const [mimeRaw, data] = url.split(",");
                             const mimeType = mimeRaw.match(/:(.*?);/)[1];
                             parts.push({ inlineData: { mimeType, data }});
                         }
                    }
                }
            }
            geminiReq.contents.push({ role, parts });
        }
    }
    
    if (systemInstruction) {
        // Gemini API 有时将 system instruction 放顶层
        // 但 wrapRequest 可能处理它，或者 geminiApi 不需要显式 systemInstruction 字段？
        // 查看 GeminiApi 实现，它直接透传 body。
        // 标准 Gemini API 有 systemInstruction 字段。
        geminiReq.systemInstruction = systemInstruction;
    }
    
    // Tools
    if (openaiReq.tools && openaiReq.tools.length > 0) {
        const functionDeclarations = openaiReq.tools.map(t => {
            if (t.type === "function") {
                return {
                    name: t.function.name,
                    description: t.function.description,
                    parameters: t.function.parameters
                };
            }
        }).filter(Boolean);
        geminiReq.tools.push({ functionDeclarations });
    }

    // Tool choice...

    return geminiReq;
}


// ==================== Claude -> OpenAI Response (Stream) ====================

function createClaudeToOpenAIStream(claudeStream, model) {
    const reader = claudeStream.getReader();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    
    const id = "chatcmpl-" + crypto.randomUUID();
    let created = Math.floor(Date.now() / 1000);

    return new ReadableStream({
        async start(controller) {
            let buffer = "";
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop() || "";
                    
                    for (const line of lines) {
                        if (!line.startsWith("data: ")) continue;
                        const dataStr = line.slice(6).trim();
                        if (dataStr === "[DONE]") {
                            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                            continue;
                        }

                        let claudeEvent;
                        try {
                            claudeEvent = JSON.parse(dataStr);
                        } catch (e) { continue; }

                        const openaiChunk = transformClaudeEventToOpenAI(claudeEvent, id, created, model);
                        if (openaiChunk) {
                            controller.enqueue(encoder.encode(`data: ${JSON.stringify(openaiChunk)}\n\n`));
                        }
                    }
                }
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            } catch (err) {
                controller.error(err);
            } finally {
                controller.close();
            }
        }
    });
}

function transformClaudeEventToOpenAI(event, id, created, model) {
    // 映射 Claude SSE 事件到 OpenAI chunk
    // content_block_delta (text) -> delta.content
    // message_start -> role
    // message_delta -> finish_reason
    
    const chunk = {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: null }]
    };

    switch (event.type) {
        case "message_start":
            chunk.choices[0].delta = { role: "assistant", content: "" };
            return chunk;
        case "content_block_start":
             // OpenAI doesn't explicitly start blocks, usually handled in delta
             // unless it's tool use
             if (event.content_block && event.content_block.type === 'tool_use') {
                 // Complex: OpenAI streams tool calls differently
                 // For now, simplify or ignore strict tool streaming if possible or handle basic text
             }
             return null;
        case "content_block_delta":
            if (event.delta.type === "text_delta") {
                chunk.choices[0].delta = { content: event.delta.text };
                return chunk;
            }
            if (event.delta.type === "thinking_delta") {
                // OpenAI non-standard: maybe reasoning_content? Or just text?
                // For "compatible", maybe just ignore or output as text?
                // DeepSeek uses "reasoning_content". Let's try that or just ignore if not requested.
                // Let's output as content for now or ignore. 
                // Better: if it's thinking, maybe prefix or use a specific field if the client supports it.
                // Standard OpenAI doesn't have thinking.
                return null; 
            }
            return null;
        case "message_delta":
            if (event.delta.stop_reason) {
                chunk.choices[0].finish_reason = mapStopReason(event.delta.stop_reason);
            }
            if (event.usage) {
                // OpenAI usage in stream is usually in the last chunk with finish_reason, 
                // but usually extra field `usage`.
                chunk.usage = event.usage; 
            }
            return chunk;
        case "message_stop":
            return null; // handled by message_delta or [DONE]
        default:
            return null;
    }
}

function mapStopReason(claudeReason) {
    if (claudeReason === "end_turn") return "stop";
    if (claudeReason === "max_tokens") return "length";
    if (claudeReason === "tool_use") return "tool_calls";
    return null;
}

// ==================== Gemini -> OpenAI Response (Stream) ====================
// Gemini API output is already unwrapped by GeminiApi.handleGenerate (if stream=true).
// However, GeminiApi.handleGenerate returns a stream of JSON objects (unwrapped response chunks),
// NOT raw SSE bytes (wait, let me check GeminiApi.handleGenerate again).

// GeminiApi.handleGenerate:
// If stream: returns { body: createUnwrapStream(...) } which is a ReadableStream of BYTES (SSE formatted).
// The stream emits `data: { ...JSON... }`.

function createGeminiToOpenAIStream(geminiStream, model) {
    const reader = geminiStream.getReader();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    
    const id = "chatcmpl-" + crypto.randomUUID();
    let created = Math.floor(Date.now() / 1000);

    return new ReadableStream({
        async start(controller) {
            let buffer = "";
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop() || "";
                    
                    for (const line of lines) {
                        if (!line.startsWith("data: ")) continue;
                        const dataStr = line.slice(6).trim();
                        if (dataStr === "[DONE]") {
                            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                            continue;
                        }

                        let geminiChunk;
                        try {
                            geminiChunk = JSON.parse(dataStr);
                        } catch (e) { continue; }

                        const openaiChunk = transformGeminiChunkToOpenAI(geminiChunk, id, created, model);
                        if (openaiChunk) {
                            controller.enqueue(encoder.encode(`data: ${JSON.stringify(openaiChunk)}\n\n`));
                        }
                    }
                }
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            } catch (err) {
                controller.error(err);
            } finally {
                controller.close();
            }
        }
    });
}

function transformGeminiChunkToOpenAI(chunk, id, created, model) {
    // Gemini chunk structure (unwrapped):
    // { candidates: [ { content: { parts: [{ text: "..." }] }, finishReason: "..." } ], usageMetadata: ... }
    
    const res = {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: null }]
    };
    
    const candidate = chunk.candidates?.[0];
    if (candidate) {
        if (candidate.content && candidate.content.parts) {
            // Include both 'text' and 'thought' (if present) as content
            const text = candidate.content.parts
                .map(p => p.text || "")
                .join("");
                
            if (text) {
                res.choices[0].delta = { content: text };
            }
        }
        if (candidate.finishReason) {
             res.choices[0].finish_reason = candidate.finishReason === "STOP" ? "stop" : candidate.finishReason.toLowerCase();
        }
    }
    
    // If usage is present, include it? (OpenAI stream usage support varies) 
    
    if (!res.choices[0].delta.content && !res.choices[0].finish_reason) {
        return null; 
    }
    
    return res;
}


// ==================== Non-Streaming Response Converters ====================

async function transformClaudeResponseToOpenAI(claudeResp, model) {
    // claudeResp is the JSON body object (not Response object)
    const id = claudeResp.id;
    
    let contentStr = "";
    if (Array.isArray(claudeResp.content)) {
      contentStr = claudeResp.content
        .map(c => {
          if (c.type === "text") return c.text || "";
          if (c.type === "tool_use") return ""; // OpenAI doesn't put tool calls in content string usually
          return "";
        })
        .join("");
    }

    // TODO: Map tool calls properly to choices[0].message.tool_calls
    
    const choices = [{
        index: 0,
        message: {
            role: claudeResp.role,
            content: contentStr || null
        },
        finish_reason: mapStopReason(claudeResp.stop_reason)
    }];
    
    return {
        id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: claudeResp.model || model,
        choices,
        usage: claudeResp.usage
    };
}

async function transformGeminiResponseToOpenAI(geminiResp, model) {
    const candidate = geminiResp.candidates?.[0];
    const choices = [{
        index: 0,
        message: {
            role: "assistant",
            content: candidate?.content?.parts?.map(p => p.text || "").join("") || null
        },
        finish_reason: candidate?.finishReason === "STOP" ? "stop" : "length" // simplified
    }];
    
    return {
        id: "chatcmpl-" + crypto.randomUUID(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices,
        usage: {
            prompt_tokens: geminiResp.usageMetadata?.promptTokenCount || 0,
            completion_tokens: geminiResp.usageMetadata?.candidatesTokenCount || 0,
            total_tokens: geminiResp.usageMetadata?.totalTokenCount || 0
        }
    };
}


module.exports = {
  transformOpenAIToClaudeRequest,
  transformOpenAIToGeminiRequest,
  createClaudeToOpenAIStream,
  createGeminiToOpenAIStream,
  transformClaudeResponseToOpenAI,
  transformGeminiResponseToOpenAI
};
