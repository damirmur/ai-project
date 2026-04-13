# My Assistant AI - Local LLM Testing Tool

A Node.js/TypeScript project for testing local LLM models using `node-llama-cpp`. This tool loads GGUF models, runs test prompts, and collects performance metrics including response time, tokens per second, context window size, and memory mode information.

## Table of Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Project Structure](#project-structure)
- [Configuration](#configuration)
- [Usage](#usage)
- [Available Models](#available-models)
- [Logging](#logging)
- [Scripts](#scripts)
- [Troubleshooting](#troubleshooting)

## Requirements

- **Node.js** >= 24.0.0
- **npm** >= 10.0.0
- **Operating System**: Linux, macOS, or Windows
- **RAM**: Minimum 8GB (16GB recommended for larger models)
- **Storage**: At least 10GB free space for models and build artifacts
- **Models Directory**: `~/.local-llm-db/models/` must exist with GGUF model files

### Model Files

Place your GGUF model files in `~/.local-llm-db/models/`:
- `qwen2.5-1.5b-instruct-q5_k_m.gguf` (default)
- `qwen2.5-3b-instruct-q5_k_m.gguf`
- `Qwen3.5-4B-Q5_K_S.gguf`
- `gemma-4-E2B-it-UD-Q5_K_M.gguf`

## Installation

### 1. Clone or navigate to the project directory

```bash
cd /path/to/my-assistent-ai
```

### 2. Install dependencies

```bash
npm install
```

The `postinstall` script will automatically build the node-llama-cpp library with CPU support (release b8771).

### 3. Configure environment variables

Copy the example environment file and adjust as needed:

```bash
cp .env_example .env
```

Edit `.env` to configure:
- `DEFAULT_MODEL`: Default model to use
- `LLM_MODELS_PATH`: Path to models directory
- `AVAILABLE_MODELS`: Comma-separated list of available models
- `LOG_FILE`: Log file path

### 4. Build the project

```bash
npm run build
```

## Project Structure

```
my-assistent-ai/
├── src/
│   ├── config/
│   │   └── llm.config.ts       # Configuration management
│   ├── services/
│   │   ├── llm.service.ts      # LLM model operations
│   │   ├── log.service.ts      # Logging service
│   │   └── question.service.ts # Question generation
│   ├── types/
│   │   ├── llm.types.ts        # Type definitions
│   │   └── services.types.ts   # Service interfaces
│   └── index.ts                # Main entry point
├── .env                        # Environment variables
├── .env_example                # Example environment file
├── .gitignore                  # Git ignore rules
├── package.json                # Project dependencies
├── tsconfig.json               # TypeScript configuration
├── README.md                   # This file
└── ARCHITECTURE.md             # Architecture documentation
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DEFAULT_MODEL` | Default model filename | `Qwen3.5-4B-Q5_K_S.gguf` |
| `LLM_MODELS_PATH` | Path to models directory | `~/.local-llm-db/models` |
| `AVAILABLE_MODELS` | Comma-separated model list | `Qwen3.5-4B-Q5_K_S.gguf,gemma-4-E2B-it-UD-Q5_K_M.gguf` |
| `LOG_FILE` | Log file path | `testllm.log` |

### Path Aliases

The project uses TypeScript path aliases for cleaner imports:

- `@/*` → `src/*`
- `@config/*` → `src/config/*`
- `@services/*` → `src/services/*`
- `@types/*` → `src/types/*`
- `@utils/*` → `src/utils/*`

## Usage

### Run with default model

```bash
npm start
```

### Run with specific model

```bash
npm start -- gemma-4-E2B-it-UD-Q5_K_M.gguf
```

### Run in development mode

```bash
npm run dev
```

### Build TypeScript

```bash
npm run build
```

### Build node-llama-cpp

For CPU-only build:
```bash
npm run build:cpu
```

For CUDA (GPU) build:
```bash
npm run build:cuda
```

**Note**: The project uses ESM modules (`"type": "module"` in package.json) because `node-llama-cpp` requires ESM with top-level await support.

## Available Models

The project supports the following models (place in `~/.local-llm-db/models/`):

1. **qwen2.5-1.5b-instruct-q5_k_m.gguf** ⭐ (default)
   - Size: ~1.5B parameters
   - Quantization: Q5_K_M
   - Fast inference, good for testing

2. **qwen2.5-3b-instruct-q5_k_m.gguf**
   - Size: ~3B parameters
   - Quantization: Q5_K_M
   - Balance between speed and quality

3. **Qwen3.5-4B-Q5_K_S.gguf**
   - Size: ~4B parameters
   - Quantization: Q5_K_S
   - Higher quality responses

4. **gemma-4-E2B-it-UD-Q5_K_M.gguf**
   - Size: ~4B parameters (2B effective)
   - Quantization: Q5_K_M
   - Google's model architecture

## Logging

All operations are logged to `testllm.log` (configurable via `.env`).

### Log Contents

- Model loading progress
- Model information
- Test questions and responses
- Performance metrics:
  - Response time (ms)
  - Tokens per second
  - Context window size
  - Memory mode
  - GPU layers used

### Log Format

```
[YYYY-MM-DDTHH:mm:ss.sssZ] [LEVEL] Message
```

## Scripts

| Script | Description |
|--------|-------------|
| `npm start` | Run the application |
| `npm run dev` | Run in development mode with ts-node |
| `npm run build` | Compile TypeScript to JavaScript |
| `npm install` | Install dependencies and build node-llama-cpp |
| `npm run build:cpu` | Build node-llama-cpp for CPU (release b8771) |
| `npm run build:cuda` | Build node-llama-cpp for CUDA GPU (release b8771) |
| `npm run postinstall` | Automatically runs after npm install |

## Troubleshooting

### Model not found

Ensure:
1. The model file exists in `~/.local-llm-db/models/`
2. The filename matches exactly (case-sensitive)
3. File permissions allow reading

### Build errors with node-llama-cpp

Try rebuilding:
```bash
npm run build:cpu
```

Or for GPU support:
```bash
npm run build:cuda
```

### Out of memory

- Reduce context window size in configuration
- Use a smaller quantized model
- Close other applications to free RAM

### Slow performance

- Enable GPU acceleration with `npm run build:cuda`
- Increase GPU layers in configuration
- Use a model with fewer parameters

## License

MIT
