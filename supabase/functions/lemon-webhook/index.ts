import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const LEMON_SIGNING_SECRET = Deno.env.get('LEMON_SIGNING_SECRET')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

async function verifySignature(payload: string, signature: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(LEMON_SIGNING_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
  const hash = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
  return hash === signature
}

serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const body = await req.text()
  const signature = req.headers.get('x-signature') || ''

  if (!await verifySignature(body, signature)) {
    return new Response('Invalid signature', { status: 401 })
  }

  const event = JSON.parse(body)
  
  if (event.meta?.event_name !== 'order_created') {
    return new Response('Ignored event', { status: 200 })
  }

  const order = event.data?.attributes
  if (!order || order.status !== 'paid') {
    return new Response('Order not paid', { status: 200 })
  }

  const customData = event.meta?.custom_data
  const userId = customData?.user_id
  const tier = customData?.tier

  if (!userId || !tier) {
    console.error('Missing user_id or tier in custom_data', customData)
    return new Response('Missing custom data', { status: 400 })
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  
  const { error } = await supabase
    .from('user_tier')
    .update({ 
      tier, 
      purchased_at: new Date().toISOString(),
      lemon_squeezy_order_id: String(event.data.id)
    })
    .eq('user_id', userId)

  if (error) {
    console.error('Failed to update tier:', error)
    return new Response('Database error', { status: 500 })
  }

  console.log(`User ${userId} upgraded to ${tier}`)
  return new Response('OK', { status: 200 })
})