export type Box = { value: number }

local function add(a: number, b: number): number
  return a + b
end

local Store = {}

function Store:run(x: number): number
  return add(x, 1)
end
