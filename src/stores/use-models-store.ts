import { create } from "zustand";

export type Model = {
  id: string;
  name: string;
  provider: string;
  contextSize: number;
  pricePer1kInput: number;
  baseRamGB: number;
  expectedTps: number;
};

const mockModels: Model[] = [
  { id: "llama-3.1-70b", name: "Llama 3.1 70B", provider: "Ollama", contextSize: 128_000, pricePer1kInput: 0, baseRamGB: 40, expectedTps: 28 },
  { id: "llama-3.1-8b", name: "Llama 3.1 8B", provider: "Ollama", contextSize: 128_000, pricePer1kInput: 0, baseRamGB: 6, expectedTps: 95 },
  { id: "qwen-2.5-coder", name: "Qwen 2.5 Coder 32B", provider: "Ollama", contextSize: 32_000, pricePer1kInput: 0, baseRamGB: 20, expectedTps: 45 },
  { id: "mistral-large", name: "Mistral Large", provider: "MLX", contextSize: 32_000, pricePer1kInput: 0, baseRamGB: 70, expectedTps: 22 },
  { id: "phi-3", name: "Phi-3 Mini", provider: "LM Studio", contextSize: 4_000, pricePer1kInput: 0, baseRamGB: 2.4, expectedTps: 180 },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "Anthropic", contextSize: 200_000, pricePer1kInput: 0.003, baseRamGB: 0, expectedTps: 120 },
  { id: "gpt-4o", name: "GPT-4o", provider: "OpenAI", contextSize: 128_000, pricePer1kInput: 0.005, baseRamGB: 0, expectedTps: 80 },
];

type ModelsState = {
  models: Model[];
  selectedModelId: string;
  selectModel: (id: string) => void;
};

export const useModelsStore = create<ModelsState>((set) => ({
  models: mockModels,
  selectedModelId: "llama-3.1-70b",
  selectModel: (id) => set({ selectedModelId: id }),
}));
