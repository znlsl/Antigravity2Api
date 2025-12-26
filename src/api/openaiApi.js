const {
  transformOpenAIToClaudeRequest,
  transformOpenAIToGeminiRequest,
  createClaudeToOpenAIStream,
  createGeminiToOpenAIStream,
  transformClaudeResponseToOpenAI,
  transformGeminiResponseToOpenAI,
} = require("../transform/openai");

class OpenaiApi {
  constructor(options = {}) {
    this.claudeApi = options.claudeApi;
    this.geminiApi = options.geminiApi;
    this.logger = options.logger || console.log;
  }

  log(title, data) {
    if (this.logger) this.logger(title, data);
    else console.log(`[${title}]`, data);
  }

  async handleChatCompletions(reqBody) {
    try {
      if (!reqBody || !reqBody.model) {
        return {
          status: 400,
          headers: { "Content-Type": "application/json" },
          body: { error: { message: "Model is required" } },
        };
      }

      const model = reqBody.model;
      const isStream = reqBody.stream === true;

      if (model.toLowerCase().startsWith("claude")) {
        return await this.handleClaudeRequest(reqBody);
      } else if (model.toLowerCase().startsWith("gemini")) {
        return await this.handleGeminiRequest(reqBody);
      } else {
        // Default to Gemini or error? Let's error for now, or maybe default to Gemini Flash?
        // Requirement says: claude->claudeApi, gemini->geminiApi.
        // If unknown, maybe return error.
        return {
          status: 400,
          headers: { "Content-Type": "application/json" },
          body: { error: { message: `Unsupported model prefix: ${model}` } },
        };
      }
    } catch (err) {
      this.log("error", `OpenAI API Error: ${err.message || err}`);
      return {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: { error: { message: "Internal Server Error" } },
      };
    }
  }

  async handleClaudeRequest(openaiReq) {
    const claudeReq = transformOpenAIToClaudeRequest(openaiReq);
    
    // Call Claude API
    // ClaudeApi.handleMessages expects the parsed JSON body of a Claude request
    const response = await this.claudeApi.handleMessages(claudeReq);

    if (response.status !== 200) {
      return response; // Pass through error
    }

    if (openaiReq.stream) {
      // response.body is a ReadableStream (SSE)
      const wrappedStream = createClaudeToOpenAIStream(response.body, openaiReq.model);
      return {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
        body: wrappedStream,
      };
    } else {
      // response.body is a JSON object
      const openaiResp = await transformClaudeResponseToOpenAI(response.body, openaiReq.model);
      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: openaiResp,
      };
    }
  }

  async handleGeminiRequest(openaiReq) {
    const geminiReq = transformOpenAIToGeminiRequest(openaiReq);
    const modelName = openaiReq.model;
    const method = openaiReq.stream ? "streamGenerateContent" : "generateContent";
    const queryString = openaiReq.stream ? "?alt=sse" : "";

    // GeminiApi.handleGenerate(modelName, method, clientBody, queryString)
    const response = await this.geminiApi.handleGenerate(modelName, method, geminiReq, queryString);

    if (response.status !== 200) {
      return response;
    }

    if (openaiReq.stream) {
      // response.body is a ReadableStream (SSE)
      const wrappedStream = createGeminiToOpenAIStream(response.body, openaiReq.model);
      return {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
        body: wrappedStream,
      };
    } else {
       // response.body is a JSON object
       const openaiResp = await transformGeminiResponseToOpenAI(response.body, openaiReq.model);
       return {
         status: 200,
         headers: { "Content-Type": "application/json" },
         body: openaiResp,
       };
    }
  }
}

module.exports = OpenaiApi;
