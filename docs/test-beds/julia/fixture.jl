module Sample

struct Box
  value::Int
end

square(x) = x * x

function run()
  square(4)
end

end
