pragma solidity ^0.8.0;

contract Vault {
  struct Entry {
    uint amount;
  }

  uint public total;

  function helper(uint amount) private returns (uint) {
    return amount * 2;
  }

  function deposit(uint amount) public returns (bool) {
    uint doubled = helper(amount);
    total += doubled;
    return doubled > 0;
  }
}
