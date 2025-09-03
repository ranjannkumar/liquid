import  { useEffect, useState } from 'react';
import { supabase } from '../supabase/supabaseClient.ts';
import { useAuth } from '../components/AuthProvider.tsx';

interface Plan {
  id: string;
  plan_option: string;
  plan_type: string;
  price: number;
  tokens: number;
}

const PricingPage = () => {
  const { session } = useAuth();
  const [subscriptionPlans, setSubscriptionPlans] = useState<Plan[]>([]);
  const [tokenPlans, setTokenPlans] = useState<Plan[]>([]);
  const functionsUrl = import.meta.env.VITE_SUPABASE_FUNCTIONS_URL;

  useEffect(() => {
    const fetchPlans = async () => {
      const { data: subs, error: subsError } = await supabase
        .from('subscription_prices')
        .select('*')
        .order('tokens', { ascending: true });

      if (subsError) console.error('Error fetching subscription plans:', subsError);
      else setSubscriptionPlans(subs || []);

      const { data: tokens, error: tokensError } = await supabase
        .from('token_prices')
        .select('*')
        .order('tokens', { ascending: true });
        
      if (tokensError) console.error('Error fetching token plans:', tokensError);
      else setTokenPlans(tokens || []);
    };
    fetchPlans();
  }, []);

  const handleCheckout = async (planType: string, planOption: string) => {
    if (!session) {
      alert("Please log in to purchase a plan.");
      return;
    }

    try {
      const response = await fetch(`${functionsUrl}/create_checkout_session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ plan_type: planType, plan_option: planOption }),
      });

      const data = await response.json();
      if (response.ok) {
        window.location.href = data.url;
      } else {
        alert(data.error || 'Failed to create checkout session.');
      }
    } catch (error) {
      console.error('Error:', error);
      alert('An internal error occurred. Please try again.');
    }
  };

  return (
    <div className="pricing-container">
      <h1>Choose a Plan</h1>
      <p className="subtitle">Secure your subscription or get one-time tokens.</p>

      <h2>Subscription Plans</h2>
      <div className="plans-grid">
        {subscriptionPlans.map((plan) => (
          <div key={plan.id} className="plan-card">
            <h3>{plan.plan_option}</h3>
            <p className="plan-tokens">{plan.tokens} Tokens</p>
            <p className="plan-price">${plan.price} / {plan.plan_type}</p>
            <button onClick={() => handleCheckout(plan.plan_type, plan.plan_option)}>
              Choose Plan
            </button>
          </div>
        ))}
      </div>

      <h2>One-Time Token Packs</h2>
      <div className="plans-grid">
        {tokenPlans.map((plan) => (
          <div key={plan.id} className="plan-card">
            <h3>{plan.plan_option}</h3>
            <p className="plan-tokens">{plan.tokens} Tokens</p>
            <p className="plan-price">${plan.price}</p>
            <button onClick={() => handleCheckout(plan.plan_type, plan.plan_option)}>
              Buy Tokens
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

export default PricingPage;