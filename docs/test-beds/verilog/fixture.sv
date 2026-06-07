module counter(input logic clk, output logic [3:0] value);
  always_ff @(posedge clk) begin
    value <= value + 1;
  end
endmodule
