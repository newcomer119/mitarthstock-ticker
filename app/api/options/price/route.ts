import { NextResponse } from 'next/server';
import { z } from 'zod';
import { priceOptionContracts } from '@/lib/actions/options.actions';

const pricingSchema = z.object({
  symbol: z.string().min(1),
  optionType: z.enum(['call', 'put']),
  strike: z.number().positive(),
  expiration: z.string().min(1),
  quantity: z.number().int().positive().optional(),
  models: z.array(z.enum(['blackScholes', 'binomial', 'monteCarlo'])).min(1),
  binomialSteps: z.number().int().positive().max(2000).optional(),
  monteCarloPaths: z.number().int().positive().max(500_000).optional(),
  monteCarloSeed: z.number().int().optional(),
  volatilityOverride: z.number().positive().optional(),
  riskFreeRateOverride: z.number().optional(),
  dividendYieldOverride: z.number().min(0).optional(),
});

export async function POST(req: Request) {
  try {
    const json = await req.json();
    const payload = pricingSchema.parse(json);
    const data = await priceOptionContracts(payload);
    return NextResponse.json(data);
  } catch (error) {
    console.error('Option pricing error:', error);
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid payload', details: error.flatten() },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: (error as Error).message ?? 'Internal Server Error' },
      { status: 500 }
    );
  }
}


