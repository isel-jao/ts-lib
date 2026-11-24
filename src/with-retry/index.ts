export interface BackoffStrategy {
  delay(attempt: number): number;
}

export class FixedBackoff implements BackoffStrategy {
  constructor(private readonly ms: number) {}
  delay(): number {
    return this.ms;
  }
}

export interface LinearBackoffOptions {
  step: number;
  max?: number;
}

export class LinearBackoff implements BackoffStrategy {
  constructor(private readonly options: LinearBackoffOptions) {
    this.validateOptions();
  }
  delay(attempt: number): number {
    const delay = this.options.step * attempt;
    return this.options.max !== undefined ? Math.min(delay, this.options.max) : delay;
  }

  private validateOptions(): void {
    if (this.options.step <= 0) {
      throw new Error("Step must be greater than 0");
    }
    if (this.options.max !== undefined) {
      if (this.options.max <= 0) {
        throw new Error("Max must be greater than 0");
      }
      if (this.options.max < this.options.step) {
        throw new Error("Max must be greater than or equal to step");
      }
    }
  }
}

export interface ExponentialBackoffOptions {
  base: number;
  max?: number;
  jitter?: boolean;
}

export class ExponentialBackoff implements BackoffStrategy {
  constructor(private readonly options: ExponentialBackoffOptions) {
    this.validateOptions();
  }

  delay(attempt: number): number {
    const capped = Math.min(
      this.options.max ?? Number.POSITIVE_INFINITY,
      this.options.base * 2 ** (attempt - 1)
    );
    return this.options.jitter ? Math.random() * capped : capped; // "full jitter"
  }

  private validateOptions(): void {
    if (this.options.base <= 0) {
      throw new Error("Base must be greater than 0");
    }
    if (this.options.max !== undefined) {
      // throw new Error("Max must be greater than 0");
      if (this.options.max <= 0) {
        throw new Error("Max must be greater than 0");
      }
      if (this.options.max < this.options.base) {
        throw new Error("Max must be greater than or equal to base");
      }
    }
  }
}

export interface WithRetryOptions<Args extends unknown[], Result> {
  maxAttempts?: number;
  strategy?: BackoffStrategy;
  callback: (...args: Args) => Result;
  onRetry?: (options: {
    attempt: number;
    delay: number;
    error: unknown;
  }) => void;
}

export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_STRATEGY: BackoffStrategy = new ExponentialBackoff({
  base: 100,
  max: 5_000,
  jitter: true,
});

export function withRetry<Args extends unknown[], Result>(
  options: WithRetryOptions<Args, Result>
): (...args: Args) => Promise<Awaited<Result>> {
  const {
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    strategy = DEFAULT_STRATEGY,
    callback,
    onRetry,
  } = options;

  return async (...args: Args): Promise<Awaited<Result>> => {
    for (let attempt = 1; ; attempt++) {
      try {
        // Promise.try turns sync throws into rejections and wraps plain return values
        return await Promise.try(callback, ...args);
      } catch (error) {
        if (attempt >= maxAttempts) throw error;
        const delay = strategy.delay(attempt);
        onRetry?.({ attempt, delay, error });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  };
}
