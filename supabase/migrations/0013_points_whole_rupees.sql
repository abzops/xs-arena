-- Suggested points on a bill are worth whole rupees, so cash bills don't end in 50 paise.
create or replace function public.customer_points(p_centre uuid, p_customer uuid, p_bill_paise bigint default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare ls loyalty_settings; v_bal int; v_max int; v_step int;
begin
  if not is_centre_member(p_centre) then raise exception 'Not allowed'; end if;
  if not exists (select 1 from customers where id = p_customer and centre_id = p_centre) then raise exception 'Customer not found'; end if;
  select * into ls from loyalty_settings where centre_id = p_centre;
  if not found or not ls.enabled or not has_feature(p_centre, 'loyalty') then return jsonb_build_object('enabled', false); end if;
  perform _loyalty_expire(p_customer);
  select coalesce(sum(points),0)::int into v_bal from loyalty_ledger where customer_id = p_customer;
  v_max := case when p_bill_paise is null then v_bal
    else least(v_bal, floor(floor(p_bill_paise * ls.max_redeem_pct / 100.0) / ls.point_value_paise))::int end;
  -- suggest a number of points worth whole rupees (e.g. 154 × ₹0.50 = ₹77, not 155 = ₹77.50)
  v_step := 100 / gcd(100, ls.point_value_paise);
  v_max := v_max - (v_max % v_step);
  return jsonb_build_object('enabled', true, 'balance', v_bal, 'value_paise', v_bal::bigint * ls.point_value_paise,
    'point_value_paise', ls.point_value_paise, 'min_redeem', ls.min_redeem_points,
    'usable', case when v_max >= ls.min_redeem_points then v_max else 0 end,
    'next_expiry', (select min(expires_at) from loyalty_ledger where customer_id = p_customer and points > 0 and expires_at > now()),
    'history', (select coalesce(jsonb_agg(jsonb_build_object('points', points, 'kind', kind, 'note', note, 'at', created_at) order by id desc), '[]')
      from (select * from loyalty_ledger where customer_id = p_customer order by id desc limit 30) h));
end $$;
