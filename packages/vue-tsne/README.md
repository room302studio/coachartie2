# @ejfox/vue-tsne

A Vue 3 composable for t-SNE (t-Distributed Stochastic Neighbor Embedding) dimensionality reduction visualization.

## Features

- 🎯 **Easy to use**: Simple Vue 3 composable API
- 📊 **Reactive**: Coordinates update automatically as t-SNE runs
- 🔧 **Configurable**: Customize perplexity, learning rate, and iterations
- 📐 **Normalized output**: Coordinates are automatically normalized to [0,1] range
- 🎨 **Flexible data**: Works with any embedding data structure
- 📱 **TypeScript**: Full TypeScript support with proper types

## Installation

```bash
npm install @ejfox/vue-tsne
# or
yarn add @ejfox/vue-tsne
# or
pnpm add @ejfox/vue-tsne
```

## Basic Usage

```vue
<script setup>
import { useTsne } from '@ejfox/vue-tsne';

const { initialize, start, coordinates, isInitialized, isRunning } = useTsne();

// Your data with embeddings
const data = [
  {
    id: '1',
    name: 'Document 1',
    extractedEmbedding: [0.1, 0.2, 0.3, 0.4, 0.5], // 5D embedding
  },
  {
    id: '2',
    name: 'Document 2',
    extractedEmbedding: [0.6, 0.7, 0.8, 0.9, 1.0],
  },
  // ... more data points
];

// Initialize and start t-SNE
initialize(data);
start();
</script>

<template>
  <div class="tsne-container" style="position: relative; width: 500px; height: 500px;">
    <div v-if="!isInitialized">Loading...</div>
    <div v-else-if="isRunning">Running t-SNE...</div>

    <!-- Render points -->
    <div
      v-for="(coord, i) in coordinates"
      :key="data[i]?.id || i"
      class="point"
      :style="{
        position: 'absolute',
        left: coord[0] * 100 + '%',
        top: coord[1] * 100 + '%',
        transform: 'translate(-50%, -50%)',
        width: '8px',
        height: '8px',
        backgroundColor: '#3b82f6',
        borderRadius: '50%',
      }"
      :title="data[i]?.name"
    />
  </div>
</template>
```

## API Reference

### `useTsne()`

Returns an object with the following properties and methods:

#### Methods

- **`initialize(data, options?)`**: Initialize t-SNE with your data
  - `data`: Array of objects with `extractedEmbedding` or `embedding` property
  - `options`: Optional configuration object

- **`start()`**: Start the t-SNE process
- **`stop()`**: Stop t-SNE iterations
- **`reset()`**: Reset t-SNE to initial state
- **`step()`**: Run a single iteration (advanced usage)

#### Reactive Properties

- **`coordinates`**: `Ref<[number, number][]>` - Current 2D coordinates normalized to [0,1]
- **`isInitialized`**: `Ref<boolean>` - Whether t-SNE has been initialized
- **`isRunning`**: `Ref<boolean>` - Whether t-SNE is currently running
- **`iterations`**: `Ref<number>` - Current iteration count
- **`maxIterations`**: `Ref<number>` - Maximum iterations (default: 500)
- **`perplexity`**: `Ref<number>` - Perplexity parameter (default: 30)

### Configuration Options

```typescript
interface TsneOptions {
  dim?: number; // Output dimensions (default: 2)
  perplexity?: number; // Perplexity parameter (default: 30)
  epsilon?: number; // Learning rate (default: 10)
  maxIterations?: number; // Maximum iterations (default: 500)
}
```

### Data Format

Your data should be an array of objects with embeddings:

```typescript
interface EmbeddingData {
  id: string;
  extractedEmbedding?: number[]; // Preferred field name
  embedding?: number[]; // Alternative field name
  [key: string]: any; // Any other properties
}
```

## Advanced Usage

### Custom Configuration

```javascript
initialize(data, {
  perplexity: 50, // Higher perplexity for larger datasets
  epsilon: 20, // Higher learning rate for faster convergence
  maxIterations: 1000, // More iterations for better results
});
```

### With Custom Styling

```vue
<template>
  <div class="visualization">
    <svg width="600" height="600" viewBox="0 0 600 600">
      <circle
        v-for="(coord, i) in coordinates"
        :key="i"
        :cx="coord[0] * 600"
        :cy="coord[1] * 600"
        :r="5"
        :fill="getColorForPoint(i)"
        @click="selectPoint(i)"
      />
    </svg>
  </div>
</template>
```

### Monitoring Progress

```vue
<script setup>
const { iterations, maxIterations, isRunning } = useTsne();

// Computed progress percentage
const progress = computed(() => {
  return Math.round((iterations.value / maxIterations.value) * 100);
});
</script>

<template>
  <div v-if="isRunning">Progress: {{ progress }}% ({{ iterations }}/{{ maxIterations }})</div>
</template>
```

## Tips

1. **Data Size**: t-SNE works best with 50-10,000 data points. For larger datasets, consider sampling.

2. **Perplexity**:
   - Use 5-50 for most datasets
   - Higher values preserve global structure
   - Lower values preserve local structure

3. **Embeddings**: Works with any dimensionality, but 50-1000 dimensions is typical.

4. **Performance**: The algorithm runs synchronously and may block for large datasets.

## Requirements

- Vue 3.0+
- @vueuse/core 10.0+

## License

MIT

## Contributing

Issues and pull requests welcome! This package is part of the [Coach Artie](https://github.com/ejfox/coachartie2) project.
