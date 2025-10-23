// @ts-ignore - tsne-js doesn't have type definitions
import TSNE from 'tsne-js';
import { ref, nextTick, type Ref } from 'vue';

/**
 * Interface for data items with embeddings
 */
export interface EmbeddingData {
  id: string;
  embedding?: number[] | null;
  extractedEmbedding?: number[];
  [key: string]: any;
}

/**
 * Configuration options for t-SNE
 */
export interface TsneOptions {
  /** Dimensionality of the output (default: 2) */
  dim?: number;
  /** Perplexity parameter (default: 30) */
  perplexity?: number;
  /** Learning rate (default: 10) */
  epsilon?: number;
  /** Maximum iterations (default: 500) */
  maxIterations?: number;
}

/**
 * Return type for the useTsne composable
 */
export interface UseTsneReturn {
  /** Initialize t-SNE with data */
  initialize: (data: EmbeddingData[], options?: TsneOptions) => void;
  /** Run a single iteration of t-SNE */
  step: () => boolean;
  /** Start the t-SNE process */
  start: () => void;
  /** Stop t-SNE iterations */
  stop: () => void;
  /** Reset t-SNE */
  reset: () => void;
  /** Current coordinates as [x, y] pairs normalized to [0,1] */
  coordinates: Ref<[number, number][]>;
  /** Current iteration count */
  iterations: Ref<number>;
  /** Maximum iterations */
  maxIterations: Ref<number>;
  /** Perplexity parameter */
  perplexity: Ref<number>;
  /** Whether t-SNE is initialized */
  isInitialized: Ref<boolean>;
  /** Whether t-SNE is currently running */
  isRunning: Ref<boolean>;
}

/**
 * Vue 3 composable for t-SNE dimensionality reduction visualization
 *
 * @example
 * ```vue
 * <script setup>
 * import { useTsne } from '@coachartie/vue-tsne'
 *
 * const { initialize, start, coordinates, isInitialized } = useTsne()
 *
 * const data = [
 *   { id: '1', extractedEmbedding: [0.1, 0.2, 0.3, ...] },
 *   { id: '2', extractedEmbedding: [0.4, 0.5, 0.6, ...] }
 * ]
 *
 * initialize(data)
 * start()
 * </script>
 *
 * <template>
 *   <div v-if="isInitialized">
 *     <div
 *       v-for="(coord, i) in coordinates"
 *       :key="i"
 *       :style="{
 *         position: 'absolute',
 *         left: coord[0] * 100 + '%',
 *         top: coord[1] * 100 + '%'
 *       }"
 *     >
 *       Point {{ i }}
 *     </div>
 *   </div>
 * </template>
 * ```
 */
export function useTsne(): UseTsneReturn {
  const tSNE = ref<TSNE | null>(null);
  const coordinates = ref<[number, number][]>([]);
  const iterations = ref(0);
  const maxIterations = ref(500);
  const perplexity = ref(30);
  const isInitialized = ref(false);
  const isRunning = ref(false);

  /**
   * Initialize t-SNE with data
   */
  function initialize(data: EmbeddingData[], options: TsneOptions = {}): void {
    try {
      if (!data || data.length === 0) {
        console.error('❌ Cannot initialize t-SNE: No data provided');
        isInitialized.value = false;
        return;
      }

      console.log(`🔧 Initializing t-SNE with ${data.length} items`);

      // Extract embeddings from each item
      const embeddings = extractEmbeddings(data);

      if (embeddings.length === 0) {
        console.error('❌ No valid embeddings found for t-SNE initialization');
        isInitialized.value = false;
        return;
      }

      const dimensions = embeddings[0].length;
      console.log(`📏 Embedding dimensions: ${dimensions}`);

      // Apply options
      if (options.perplexity !== undefined) {
        perplexity.value = options.perplexity;
      }
      if (options.maxIterations !== undefined) {
        maxIterations.value = options.maxIterations;
      }

      // Create a new t-SNE instance
      tSNE.value = new TSNE({
        dim: options.dim || 2,
        perplexity: perplexity.value,
        epsilon: options.epsilon || 10,
      });

      // Initialize with the extracted embeddings
      tSNE.value.init({
        data: embeddings,
        type: 'dense',
      });

      isInitialized.value = true;
      iterations.value = 0;
      console.log('✅ t-SNE initialized successfully');
    } catch (error) {
      console.error('❌ Error initializing t-SNE:', error);
      isInitialized.value = false;
    }
  }

  /**
   * Extract embeddings from data items
   */
  function extractEmbeddings(data: EmbeddingData[]): number[][] {
    console.log('🔎 Extracting embeddings for t-SNE...');

    // Prioritize extractedEmbedding, fall back to embedding
    const withEmbeddings = data.filter((item) => {
      const embedding = item.extractedEmbedding || item.embedding;
      return embedding && Array.isArray(embedding) && embedding.length > 0;
    });

    if (withEmbeddings.length > 0) {
      console.log(`🎯 Using ${withEmbeddings.length} embeddings`);

      const embeddings = withEmbeddings.map((item) => {
        return (item.extractedEmbedding || item.embedding) as number[];
      });

      if (embeddings.length > 0) {
        console.log('📊 First embedding sample:', embeddings[0].slice(0, 5), '...');
        console.log('📐 Embedding dimension:', embeddings[0].length);
      }

      return embeddings;
    }

    console.warn('⚠️ No valid embeddings found');
    return [];
  }

  /**
   * Run a single iteration of t-SNE
   */
  function step(): boolean {
    if (!tSNE.value || !isInitialized.value) {
      console.warn('⚠️ Cannot step: t-SNE not initialized');
      return false;
    }

    try {
      if (iterations.value >= maxIterations.value) {
        console.log('🏁 Reached maximum iterations');
        isRunning.value = false;
        return false;
      }

      // Run the entire t-SNE process on first step
      if (iterations.value === 0) {
        console.log('🚀 Running t-SNE process...');

        tSNE.value.run();
        iterations.value = tSNE.value.getIter();
        const error = tSNE.value.getError();

        console.log(
          `📉 t-SNE completed with ${iterations.value} iterations, final error: ${error}`
        );

        updateCoordinates();
        isRunning.value = false;
        return false;
      }

      iterations.value++;

      if (iterations.value % 10 === 0) {
        console.log(`📉 t-SNE iteration ${iterations.value}/${maxIterations.value}`);
      }

      return true;
    } catch (error) {
      console.error('❌ Error in t-SNE step:', error);
      isRunning.value = false;
      return false;
    }
  }

  /**
   * Update coordinates from t-SNE solution
   */
  function updateCoordinates(): void {
    if (!tSNE.value || !isInitialized.value) {
      console.warn('⚠️ Cannot update coordinates: t-SNE not initialized');
      coordinates.value = [];
      return;
    }

    try {
      const solution = tSNE.value.getSolution();
      console.log('📊 Raw t-SNE solution:', solution.length, 'points');

      if (!solution || solution.length === 0) {
        console.warn('⚠️ t-SNE solution is empty');
        coordinates.value = [];
        return;
      }

      // Find min/max values for normalization
      let minX = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;

      solution.forEach((point: number[]) => {
        minX = Math.min(minX, point[0]);
        maxX = Math.max(maxX, point[0]);
        minY = Math.min(minY, point[1]);
        maxY = Math.max(maxY, point[1]);
      });

      // Add buffer to prevent edge cases
      const buffer = 0.05;
      minX -= buffer;
      maxX += buffer;
      minY -= buffer;
      maxY += buffer;

      console.log('📊 Coordinate ranges:', { minX, maxX, minY, maxY });

      // Normalize coordinates to [0,1] range
      const normalizedCoordinates = solution.map((point: number[]) => {
        const x = (point[0] - minX) / (maxX - minX);
        const y = (point[1] - minY) / (maxY - minY);

        const safeX = Math.max(0, Math.min(1, x));
        const safeY = Math.max(0, Math.min(1, y));

        return [safeX, safeY] as [number, number];
      });

      coordinates.value = normalizedCoordinates;

      if (coordinates.value && coordinates.value.length > 0) {
        console.log(`🎯 Updated coordinates for ${coordinates.value.length} points`);
        console.log('📍 Sample coordinates:', coordinates.value.slice(0, 3));
      }

      nextTick(() => {
        if (coordinates.value) {
          console.log('✅ Coordinates updated in next tick, length:', coordinates.value.length);
        }
      });
    } catch (error) {
      console.error('❌ Error getting t-SNE solution:', error);
      coordinates.value = [];
    }
  }

  /**
   * Start t-SNE process
   */
  function start(): void {
    if (!isInitialized.value) {
      console.warn('⚠️ Cannot start: t-SNE not initialized');
      return;
    }

    isRunning.value = true;
    console.log('▶️ Starting t-SNE process');

    const result = step();
    console.log('t-SNE step result:', result);
    console.log('Coordinates after step:', coordinates.value ? coordinates.value.length : 'null');
  }

  /**
   * Stop t-SNE iterations
   */
  function stop(): void {
    console.log('⏹️ Stopping t-SNE');
    isRunning.value = false;
  }

  /**
   * Reset t-SNE
   */
  function reset(): void {
    stop();
    tSNE.value = null;
    coordinates.value = [];
    iterations.value = 0;
    isInitialized.value = false;
    console.log('🔄 t-SNE reset');
  }

  return {
    initialize,
    step,
    start,
    stop,
    reset,
    coordinates,
    iterations,
    maxIterations,
    perplexity,
    isInitialized,
    isRunning,
  };
}
