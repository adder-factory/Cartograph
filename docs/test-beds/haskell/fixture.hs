module Sample where

square :: Int -> Int
square x = x * x

main :: IO ()
main = print (square 4)
